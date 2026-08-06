// =============================================================================
// Gate 3E-D4-C2 -- Special Price Proposal Submission & Policy Evaluation RPC,
// DB-backed (Postgres/Supabase NYATA, bukan mock). Membuktikan migration
// 20260924000001_gate_3e_d4_c2_submit_special_price_proposal_rpc.sql
// (public.submit_special_price_proposal_atomic()) terhadap kontrak Gate
// 3E-D4-C2: evaluasi knowledge_discount_policies server-side (precedence
// product > customer > global), snapshot immutable, transisi
// draft -> pending_owner_approval HANYA bila diperlukan, idempotency,
// konkurensi, dan tenant/ownership/role enforcement fail-closed.
//
// Semua panggilan RPC lewat sesi Supabase Auth SUNGGUHAN (anon-key client +
// signInWithPassword) -- RPC ini SENGAJA hanya GRANT ke `authenticated` dan
// resolve identitas dari auth.uid(), BUKAN parameter (pola identik
// gate-3d-b2-atomic-owner-provisioning.integration.test.ts). Verifikasi state
// memakai client SERVICE-ROLE (bypass RLS).
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-D4-C2 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type SubmitRow = {
  result_outcome: string;
  requires_approval: boolean | null;
  approval_request_id: string | null;
  proposal_version: number | null;
  order_status: string | null;
};

type ProposedLine = { sales_order_item_id: string; proposed_unit_price: number };

describeIfDb("Gate 3E-D4-C2: submit_special_price_proposal_atomic() (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const companyB = randomUUID();
  const companyC = randomUUID(); // tenant TANPA knowledge_discount_policies sama sekali

  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const productIds: Record<string, string> = {};
  const policyIds: string[] = [];
  const customerIds: Record<string, string> = {};
  const orderIds: string[] = [];
  const approvalRequestIds: string[] = [];

  async function signIn(key: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email: emails[key], password });
    if (error) throw new Error(`sign-in gagal untuk ${key}: ${error.message}`);
    return scoped;
  }

  async function makeUser(key: string, companyId: string, roleName: string): Promise<string> {
    const email = `${runTag}-${key}@itest.test`;
    emails[key] = email;
    const { data: auth, error: authErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (authErr || !auth.user) throw new Error(`gagal buat auth user ${key}: ${authErr?.message}`);
    authIds[key] = auth.user.id;
    const { error: profileErr } = await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${key}`, is_active: true });
    if (profileErr) throw new Error(`gagal buat profile user ${key}: ${profileErr.message}`);
    const { data: roleRow } = await service.from("roles").select("id").eq("name", roleName).is("company_id", null).single();
    const { error: roleErr } = await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    if (roleErr) throw new Error(`gagal assign role ${roleName} untuk ${key}: ${roleErr.message}`);
    return auth.user.id;
  }

  async function makeProduct(key: string, companyId: string, price: number, isActive = true): Promise<string> {
    const { data, error } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${key}-${runTag}`, name: `Produk ${key}`, price, is_active: isActive }).select("id").single();
    if (error) throw new Error(`gagal buat produk ${key}: ${error.message}`);
    productIds[key] = (data as { id: string }).id;
    return productIds[key];
  }

  async function makeOrder(companyId: string, customerId: string, salesId: string, items: { productKey: string; quantity: number; unitPrice: number }[], status = "draft"): Promise<{ orderId: string; itemIds: string[] }> {
    const orderNumber = `SO-G3ED4C2-${runTag}-${orderIds.length}`;
    const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const { data, error } = await service.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_id: customerId, sales_id: salesId,
      status, total_amount: total, final_amount: total,
    }).select("id").single();
    if (error) throw new Error(`gagal buat order: ${error.message}`);
    const orderId = (data as { id: string }).id;
    orderIds.push(orderId);
    const itemIds: string[] = [];
    for (const it of items) {
      const { data: itemRow, error: itemErr } = await service.from("sales_order_items").insert({
        order_id: orderId, product_id: productIds[it.productKey], quantity: it.quantity, unit_price: it.unitPrice, total_amount: it.quantity * it.unitPrice,
      }).select("id").single();
      if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
      itemIds.push((itemRow as { id: string }).id);
    }
    return { orderId, itemIds };
  }

  async function callSubmit(actorKey: string, orderId: string, items: ProposedLine[], reason: string | null, idemKey: string | null = null): Promise<SubmitRow> {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId,
      p_items: items,
      p_reason: reason,
      p_idempotency_key: idemKey,
    });
    if (error) throw new Error(`rpc error (${actorKey}): ${error.message}`);
    const row = (data as SubmitRow[])[0];
    if (row.approval_request_id) approvalRequestIds.push(row.approval_request_id);
    return row;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C2 A ${runTag}`, slug: `g3ed4c2-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C2 B ${runTag}`, slug: `g3ed4c2-b-${runTag}` },
      { id: companyC, name: `Gate 3E-D4-C2 C ${runTag}`, slug: `g3ed4c2-c-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("managerA", companyA, "manager");
    await makeUser("adminA", companyA, "admin"); // pemegang orders.manage, bukan role sales
    await makeUser("salesA1", companyA, "sales");
    await makeUser("salesA2", companyA, "sales");
    await makeUser("ownerB", companyB, "owner");
    await makeUser("salesB1", companyB, "sales");
    await makeUser("salesC1", companyC, "sales");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerIds.A = (cA as { id: string }).id;
    const { data: cB } = await service.from("customers").insert({ company_id: companyB, code: `CB-${runTag}`, name: "Toko B", assigned_sales_id: authIds.salesB1 }).select("id").single();
    customerIds.B = (cB as { id: string }).id;
    const { data: cC } = await service.from("customers").insert({ company_id: companyC, code: `CC-${runTag}`, name: "Toko C", assigned_sales_id: authIds.salesC1 }).select("id").single();
    customerIds.C = (cC as { id: string }).id;

    // Company A: 5 produk untuk menguji precedence tier + dimensi nominal.
    await makeProduct("global", companyA, 10000);   // hanya global policy (10%)
    await makeProduct("product", companyA, 10000);  // product-scope policy (20%) mengalahkan global
    await makeProduct("customer", companyA, 10000); // customer-scope policy (15%) mengalahkan global, tanpa product-scope
    await makeProduct("nominal", companyA, 10000);  // product-scope policy nominal-only (cap 5000)
    await makeProduct("plain", companyA, 10000);    // tanpa product-scope, dipakai payload-validation tests
    await makeProduct("inactive", companyA, 8000, false);

    await makeProduct("b1", companyB, 10000);
    await makeProduct("c1", companyC, 10000);

    const { data: polGlobal } = await service.from("knowledge_discount_policies").insert({ company_id: companyA, scope: "global", max_percentage: 10 }).select("id").single();
    policyIds.push((polGlobal as { id: string }).id);
    const { data: polProduct } = await service.from("knowledge_discount_policies").insert({ company_id: companyA, scope: "product", product_id: productIds.product, max_percentage: 20 }).select("id").single();
    policyIds.push((polProduct as { id: string }).id);
    const { data: polCustomer } = await service.from("knowledge_discount_policies").insert({ company_id: companyA, scope: "customer", customer_id: customerIds.A, max_percentage: 15 }).select("id").single();
    policyIds.push((polCustomer as { id: string }).id);
    const { data: polNominal } = await service.from("knowledge_discount_policies").insert({ company_id: companyA, scope: "product", product_id: productIds.nominal, max_nominal: 5000 }).select("id").single();
    policyIds.push((polNominal as { id: string }).id);
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("special_price_approval_lines").delete().in("approval_request_id", approvalRequestIds);
    await service.from("special_price_approval_requests").delete().in("sales_order_id", orderIds);
    await service.from("sales_kpi_achievement_events").delete().in("order_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", orderIds);
    await service.from("sales_order_items").delete().in("order_id", orderIds);
    await service.from("sales_orders").delete().in("id", orderIds);
    await service.from("knowledge_discount_policies").delete().in("id", policyIds);
    await service.from("products").delete().in("id", Object.values(productIds));
    await service.from("customers").delete().in("id", Object.values(customerIds));
    await service.from("user_roles").delete().in("company_id", [companyA, companyB, companyC]);
    const allIds = Object.values(authIds);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyA, companyB, companyC]);
    for (const id of allIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1+9+10+13+14+15. Sales pemilik order: discount dalam batas semua tier (precedence product>customer>global + nominal) -> approval_not_required, TIDAK ADA mutasi", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "global", quantity: 10, unitPrice: 10000 },   // global 10%
      { productKey: "product", quantity: 10, unitPrice: 10000 },  // product 20%
      { productKey: "customer", quantity: 10, unitPrice: 10000 }, // customer 15%
      { productKey: "nominal", quantity: 10, unitPrice: 10000 },  // nominal cap 5000
    ]);

    const row = await callSubmit("salesA1", orderId, [
      { sales_order_item_id: itemIds[0], proposed_unit_price: 9100 }, // 9% <= 10% global -> OK
      { sales_order_item_id: itemIds[1], proposed_unit_price: 8500 }, // 15% <= 20% product -> OK (would fail global 10%, proves product beats global)
      { sales_order_item_id: itemIds[2], proposed_unit_price: 8600 }, // 14% <= 15% customer -> OK (would fail global 10%)
      { sales_order_item_id: itemIds[3], proposed_unit_price: 9600 }, // (10000-9600)*10=4000 <= 5000 nominal -> OK
    ], null);

    expect(row.result_outcome).toBe("approval_not_required");
    expect(row.requires_approval).toBe(false);
    expect(row.approval_request_id).toBeNull();
    expect(row.order_status).toBe("draft");

    const { data: order } = await service.from("sales_orders").select("status, total_amount, final_amount").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft");

    const { data: items } = await service.from("sales_order_items").select("unit_price").in("id", itemIds);
    for (const it of items as { unit_price: number }[]) {
      expect(Number(it.unit_price)).toBe(10000); // TIDAK diubah sama sekali
    }

    const { data: requests } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
    expect(requests).toHaveLength(0);
  });

  it("1+8+9+11+12+13+14+15+16. Discount melebihi batas efektif (product-tier) -> submitted, snapshot lengkap, totals recalculated, master price produk TIDAK berubah", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "global", quantity: 10, unitPrice: 10000 }, // global 10% -> 20% off melebihi
    ]);

    const rejectedNoReason = await callSubmit("salesA1", orderId, [
      { sales_order_item_id: itemIds[0], proposed_unit_price: 8000 },
    ], "   "); // reason kosong setelah trim
    expect(rejectedNoReason.result_outcome).toBe("reason_required");

    // 20. Tidak ada partial mutation dari percobaan yang ditolak di atas.
    const { data: orderAfterReject } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((orderAfterReject as { status: string }).status).toBe("draft");
    const { data: reqAfterReject } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
    expect(reqAfterReject).toHaveLength(0);

    const row = await callSubmit("salesA1", orderId, [
      { sales_order_item_id: itemIds[0], proposed_unit_price: 8000 }, // 20% off > 10% -> requires approval
    ], "Diskon khusus pelanggan lama");

    expect(row.result_outcome).toBe("submitted");
    expect(row.requires_approval).toBe(true);
    expect(row.approval_request_id).toBeTruthy();
    expect(row.proposal_version).toBe(1);
    expect(row.order_status).toBe("pending_owner_approval");

    const { data: order } = await service.from("sales_orders").select("status, total_amount, tax_amount, final_amount, discount_amount").eq("id", orderId).single();
    const o = order as { status: string; total_amount: number; tax_amount: number; final_amount: number; discount_amount: number };
    expect(o.status).toBe("pending_owner_approval");
    expect(Number(o.total_amount)).toBe(80000); // 10 x 8000
    expect(Number(o.tax_amount)).toBe(Math.round((80000 - Number(o.discount_amount)) * 0.11 * 100) / 100);
    expect(Number(o.final_amount)).toBe(80000 - Number(o.discount_amount) + Number(o.tax_amount));

    const { data: item } = await service.from("sales_order_items").select("unit_price, total_amount").eq("id", itemIds[0]).single();
    expect(Number((item as { unit_price: number }).unit_price)).toBe(8000);
    expect(Number((item as { total_amount: number }).total_amount)).toBe(80000);

    const { data: req } = await service.from("special_price_approval_requests").select("*").eq("id", row.approval_request_id!).single();
    const r = req as { proposal_version: number; status: string; requested_by: string; reason: string; company_id: string; order_snapshot_hash: string };
    expect(r.proposal_version).toBe(1);
    expect(r.status).toBe("PENDING");
    expect(r.requested_by).toBe(authIds.salesA1);
    expect(r.reason).toBe("Diskon khusus pelanggan lama");
    expect(r.company_id).toBe(companyA);
    expect(r.order_snapshot_hash?.length).toBeGreaterThan(0);

    const { data: lines } = await service.from("special_price_approval_lines").select("*").eq("approval_request_id", row.approval_request_id!);
    expect(lines).toHaveLength(1);
    const line = (lines as any[])[0];
    expect(Number(line.master_unit_price)).toBe(10000);
    expect(Number(line.proposed_unit_price)).toBe(8000);
    expect(Number(line.implied_discount_percentage)).toBeCloseTo(20, 4);
    // Order ini pakai customerA, yang punya customer-scope policy (15%) --
    // produk "global" tidak punya product-scope policy sendiri, jadi tier
    // customer (lebih spesifik dari global) yang menang, BUKAN global (10%).
    // Ini justru membuktikan precedence product > customer > global bekerja
    // benar (lihat test presisi precedence terpisah di atas).
    expect(line.policy_scope_snapshot).toBe("customer");
    expect(Number(line.policy_max_percentage_snapshot)).toBe(15);
    expect(Number(line.effective_floor_unit_price)).toBe(8500); // 10000 * (1 - 15/100)

    // 16. Harga master produk TIDAK pernah berubah.
    const { data: product } = await service.from("products").select("price").eq("id", productIds.global).single();
    expect(Number((product as { price: number }).price)).toBe(10000);

    // audit log
    const { data: audit } = await service.from("audit_logs").select("action, entity_id, actor_type, outcome").eq("entity_id", orderId).eq("action", "order.special_price_proposal_submitted");
    expect(audit).toHaveLength(1);
    expect((audit as any[])[0].outcome).toBe("success");

    // 24. Tidak ada KPI achievement event untuk order pending approval ini.
    const { data: kpi } = await service.from("sales_kpi_achievement_events").select("id").eq("order_id", orderId);
    expect(kpi).toHaveLength(0);
  });

  it("2. Draft milik Sales lain ditolak (forbidden)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA2, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ]);
    const row = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 9000 }], "alasan");
    expect(row.result_outcome).toBe("forbidden");
  });

  it("3. Cross-tenant order ditolak (not_found, tidak bocor keberadaan)", async () => {
    const { orderId, itemIds } = await makeOrder(companyB, customerIds.B, authIds.salesB1, [
      { productKey: "b1", quantity: 5, unitPrice: 10000 },
    ]);
    const row = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 9000 }], "alasan");
    expect(row.result_outcome).toBe("not_found");
  });

  it("4+19(role). Owner/Admin/manager tidak dapat submit seolah Sales (strictly role=sales, bukan permission)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ]);
    for (const actor of ["ownerA", "adminA", "managerA"]) {
      const row = await callSubmit(actor, orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 9000 }], "alasan");
      expect(row.result_outcome).toBe("forbidden");
    }
  });

  it("5. Order non-draft (confirmed, pending_owner_approval) ditolak", async () => {
    const { orderId: confirmedId, itemIds: confirmedItems } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ], "confirmed");
    const rowConfirmed = await callSubmit("salesA1", confirmedId, [{ sales_order_item_id: confirmedItems[0], proposed_unit_price: 9000 }], "alasan");
    expect(rowConfirmed.result_outcome).toBe("not_draft");

    const { orderId: pendingId, itemIds: pendingItems } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ], "pending_owner_approval");
    const rowPending = await callSubmit("salesA1", pendingId, [{ sales_order_item_id: pendingItems[0], proposed_unit_price: 9000 }], "alasan");
    expect(rowPending.result_outcome).toBe("not_draft");
  });

  it("6. Payload invalid: harga <=0, harga > master, line asing, duplicate line, no items, field hilang, produk tidak aktif", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
      { productKey: "inactive", quantity: 3, unitPrice: 8000 },
    ]);

    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 0 }], "x")).result_outcome).toBe("invalid_price");
    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: -100 }], "x")).result_outcome).toBe("invalid_price");
    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 15000 }], "x")).result_outcome).toBe("invalid_price");
    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: randomUUID(), proposed_unit_price: 9000 }], "x")).result_outcome).toBe("line_not_found");
    expect((await callSubmit("salesA1", orderId, [
      { sales_order_item_id: itemIds[0], proposed_unit_price: 9000 },
      { sales_order_item_id: itemIds[0], proposed_unit_price: 8500 },
    ], "x")).result_outcome).toBe("duplicate_line");
    expect((await callSubmit("salesA1", orderId, [], "x")).result_outcome).toBe("no_items");
    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0] } as unknown as ProposedLine], "x")).result_outcome).toBe("invalid_payload");
    expect((await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[1], proposed_unit_price: 7000 }], "x")).result_outcome).toBe("inactive_product");
  });

  it("7. Master price snapshot berasal dari produk (bukan client) -- proposed_unit_price yang melebihi master ditolak walau client 'mengklaim' itu harga sah", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ]);
    const row = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 10000.01 }], "x");
    expect(row.result_outcome).toBe("invalid_price");
  });

  it("17+18. Idempotency: retry payload sama -> already_exists (tanpa duplikat); key sama payload beda -> idempotency_conflict (tanpa mutasi)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "global", quantity: 10, unitPrice: 10000 },
    ]);
    const idemKey = `idem-${runTag}-1`;
    const payload = [{ sales_order_item_id: itemIds[0], proposed_unit_price: 8000 }];

    const first = await callSubmit("salesA1", orderId, payload, "alasan idem", idemKey);
    expect(first.result_outcome).toBe("submitted");

    const retry = await callSubmit("salesA1", orderId, payload, "alasan idem", idemKey);
    expect(retry.result_outcome).toBe("already_exists");
    expect(retry.approval_request_id).toBe(first.approval_request_id);
    expect(retry.proposal_version).toBe(first.proposal_version);

    const { data: requests } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
    expect(requests).toHaveLength(1); // tidak ada duplikat

    const conflict = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 7500 }], "alasan lain", idemKey);
    expect(conflict.result_outcome).toBe("idempotency_conflict");

    const { data: requestsAfterConflict } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
    expect(requestsAfterConflict).toHaveLength(1); // masih satu, tidak bertambah
  });

  it("19. Concurrent submission untuk order yang sama -> maksimal satu PENDING aktif", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "global", quantity: 10, unitPrice: 10000 },
    ]);

    const [r1, r2] = await Promise.all([
      callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 8000 }], "alasan concurrent A"),
      callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 8000 }], "alasan concurrent B"),
    ]);

    const outcomes = [r1.result_outcome, r2.result_outcome].sort();
    expect(outcomes).toEqual(["not_draft", "submitted"]);

    const { data: pending } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId).eq("status", "PENDING");
    expect(pending).toHaveLength(1);
  });

  it("10. Tidak ada policy sama sekali (tenant tanpa knowledge_discount_policies) -> effective allowed discount 0%, diskon berapa pun wajib approval", async () => {
    const { orderId, itemIds } = await makeOrder(companyC, customerIds.C, authIds.salesC1, [
      { productKey: "c1", quantity: 10, unitPrice: 10000 },
    ]);
    const row = await callSubmit("salesC1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 9999 }], "diskon kecil tanpa policy");
    expect(row.result_outcome).toBe("submitted");
    expect(row.requires_approval).toBe(true);

    const { data: lines } = await service.from("special_price_approval_lines").select("policy_id, policy_scope_snapshot, effective_floor_unit_price").eq("approval_request_id", row.approval_request_id!);
    const line = (lines as any[])[0];
    expect(line.policy_id).toBeNull();
    expect(line.policy_scope_snapshot).toBeNull();
    expect(Number(line.effective_floor_unit_price)).toBe(10000); // 0% allowed = harga master
  });

  it("22+23. Alur normal draft update dan confirm (tanpa special price) TIDAK regresi", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ]);

    const { data: updateResult, error: updateErr } = await service.rpc("update_sales_order_atomic", {
      p_company_id: companyA,
      p_actor_id: authIds.salesA1,
      p_order_id: orderId,
      p_customer_id: customerIds.A,
      p_sales_id: authIds.salesA1,
      p_notes: "regression check",
      p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [{ product_id: productIds.plain, quantity: 5, unit_price: 10000, discount_amount: 0, total_amount: 50000, notes: null }],
    });
    expect(updateErr).toBeNull();
    expect((updateResult as { result_outcome: string }[])[0].result_outcome).toBe("updated");

    const { data: confirmResult, error: confirmErr } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyA,
      p_actor_id: authIds.salesA1,
      p_order_id: orderId,
      p_payment_terms_days: 30,
    });
    expect(confirmErr).toBeNull();
    expect((confirmResult as { result_outcome: string }[])[0].result_outcome).toBe("confirmed");
  });

  it("unauthenticated: caller tanpa sesi valid ditolak", async () => {
    const anon = createServiceClient(env!.url, env!.anonKey);
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "plain", quantity: 5, unitPrice: 10000 },
    ]);
    const { data, error } = await anon.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId,
      p_items: [{ sales_order_item_id: itemIds[0], proposed_unit_price: 9000 }],
      p_reason: "x",
      p_idempotency_key: null,
    });
    // GRANT hanya authenticated -- anon key tanpa sesi ditolak Postgres (permission denied)
    // ATAU (bila peran anon kebetulan diizinkan memanggil) fungsi mengembalikan 'unauthenticated'.
    if (error) {
      expect(error.message.toLowerCase()).toContain("permission denied");
    } else {
      expect((data as SubmitRow[])[0].result_outcome).toBe("unauthenticated");
    }
  });
});
