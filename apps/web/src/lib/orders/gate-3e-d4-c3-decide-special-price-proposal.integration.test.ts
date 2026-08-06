// =============================================================================
// Gate 3E-D4-C3 -- Owner Special Price Approval Decision RPC, DB-backed
// (Postgres/Supabase NYATA, bukan mock). Membuktikan migration
// 20260925000001_gate_3e_d4_c3_decide_special_price_proposal_rpc.sql
// (public.decide_special_price_proposal_atomic()) terhadap kontrak Gate
// 3E-D4-C3: strict-Owner authorization, transisi APPROVE/REJECT, restorasi
// harga master pada REJECT, recalculation totals, idempotency,
// concurrent-decision behavior, dan snapshot/current-line mismatch
// fail-closed.
//
// Semua panggilan RPC lewat sesi Supabase Auth SUNGGUHAN (anon-key client +
// signInWithPassword) -- RPC ini SENGAJA hanya GRANT ke `authenticated` dan
// resolve identitas dari auth.uid(), BUKAN parameter. Verifikasi state
// memakai client SERVICE-ROLE (bypass RLS) -- juga dipakai untuk
// mensimulasikan skenario mismatch/invalid-state yang tidak bisa dicapai
// lewat jalur RPC normal (defense-in-depth, bukan bug jalur normal).
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
  console.warn("Gate 3E-D4-C3 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type SubmitRow = {
  result_outcome: string;
  requires_approval: boolean | null;
  approval_request_id: string | null;
  proposal_version: number | null;
  order_status: string | null;
};

type DecideRow = {
  result_outcome: string;
  approval_request_id: string | null;
  decision: string | null;
  proposal_version: number | null;
  order_status: string | null;
  decided_at: string | null;
};

type ProposedLine = { sales_order_item_id: string; proposed_unit_price: number };

describeIfDb("Gate 3E-D4-C3: decide_special_price_proposal_atomic() (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const companyB = randomUUID();

  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const productIds: Record<string, string> = {};
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

  async function makeProduct(key: string, companyId: string, price: number): Promise<string> {
    const { data, error } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${key}-${runTag}`, name: `Produk ${key}`, price, is_active: true }).select("id").single();
    if (error) throw new Error(`gagal buat produk ${key}: ${error.message}`);
    productIds[key] = (data as { id: string }).id;
    return productIds[key];
  }

  async function makeOrder(companyId: string, customerId: string, salesId: string, items: { productKey: string; quantity: number; unitPrice: number }[]): Promise<{ orderId: string; itemIds: string[] }> {
    const orderNumber = `SO-G3ED4C3-${runTag}-${orderIds.length}`;
    const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const { data, error } = await service.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_id: customerId, sales_id: salesId,
      status: "draft", total_amount: total, final_amount: total,
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

  async function callSubmit(actorKey: string, orderId: string, items: ProposedLine[], reason: string | null): Promise<SubmitRow> {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId,
      p_items: items,
      p_reason: reason,
      p_idempotency_key: null,
    });
    if (error) throw new Error(`submit rpc error (${actorKey}): ${error.message}`);
    const row = (data as SubmitRow[])[0];
    if (row.approval_request_id) approvalRequestIds.push(row.approval_request_id);
    return row;
  }

  // Helper: buat order+proposal PENDING siap-decide (dipakai hampir semua test).
  async function makePendingProposal(
    productKey: string,
    salesKey: string,
    customerId: string,
    companyId: string,
    unitPrice = 10000,
    proposedPrice = 8000,
    quantity = 10,
  ): Promise<{ orderId: string; itemId: string; approvalRequestId: string }> {
    const { orderId, itemIds } = await makeOrder(companyId, customerId, authIds[salesKey], [
      { productKey, quantity, unitPrice },
    ]);
    const row = await callSubmit(salesKey, orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: proposedPrice }], "alasan proposal");
    expect(row.result_outcome).toBe("submitted");
    return { orderId, itemId: itemIds[0], approvalRequestId: row.approval_request_id! };
  }

  async function callDecide(actorKey: string, approvalRequestId: string, decision: string, idemKey: string, reason: string | null = null): Promise<DecideRow> {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: approvalRequestId,
      p_decision: decision,
      p_idempotency_key: idemKey,
      p_decision_reason: reason,
    });
    if (error) throw new Error(`decide rpc error (${actorKey}): ${error.message}`);
    return (data as DecideRow[])[0];
  }

  let idemCounter = 0;
  function nextIdemKey(): string {
    idemCounter += 1;
    return `idem-decide-${runTag}-${idemCounter}`;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C3 A ${runTag}`, slug: `g3ed4c3-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C3 B ${runTag}`, slug: `g3ed4c3-b-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("adminA", companyA, "admin");
    await makeUser("managerA", companyA, "manager");
    await makeUser("salesA1", companyA, "sales");
    await makeUser("ownerB", companyB, "owner");
    await makeUser("salesB1", companyB, "sales");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerIds.A = (cA as { id: string }).id;
    const { data: cB } = await service.from("customers").insert({ company_id: companyB, code: `CB-${runTag}`, name: "Toko B", assigned_sales_id: authIds.salesB1 }).select("id").single();
    customerIds.B = (cB as { id: string }).id;

    await makeProduct("p1", companyA, 10000);
    await makeProduct("p2", companyA, 10000);
    await makeProduct("p3", companyA, 10000);
    await makeProduct("p4", companyA, 10000);
    await makeProduct("p5", companyA, 10000);
    await makeProduct("p6", companyA, 10000);
    await makeProduct("p7", companyA, 10000);
    await makeProduct("p8", companyA, 10000);
    await makeProduct("p9", companyA, 10000);
    await makeProduct("p10", companyA, 10000);
    await makeProduct("p11", companyA, 10000);
    await makeProduct("dup", companyA, 20000); // dipakai test duplicate product_id per order
    await makeProduct("b1", companyB, 10000);
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("special_price_approval_lines").delete().in("approval_request_id", approvalRequestIds);
    await service.from("special_price_approval_requests").delete().in("sales_order_id", orderIds);
    await service.from("sales_kpi_achievement_events").delete().in("order_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", approvalRequestIds);
    await service.from("sales_order_items").delete().in("order_id", orderIds);
    await service.from("sales_orders").delete().in("id", orderIds);
    await service.from("products").delete().in("id", Object.values(productIds));
    await service.from("customers").delete().in("id", Object.values(customerIds));
    await service.from("user_roles").delete().in("company_id", [companyA, companyB]);
    const allIds = Object.values(authIds);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyA, companyB]);
    for (const id of allIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1+10+11+26. Owner tenant sama: APPROVE PENDING -> proposed price dipertahankan, order->draft, TIDAK confirm, TIDAK KPI", async () => {
    const { orderId, itemId, approvalRequestId } = await makePendingProposal("p1", "salesA1", customerIds.A, companyA);

    const row = await callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey());
    expect(row.result_outcome).toBe("approved");
    expect(row.decision).toBe("APPROVED");
    expect(row.order_status).toBe("draft");
    expect(row.decided_at).toBeTruthy();

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft"); // 11: BUKAN 'confirmed'

    const { data: item } = await service.from("sales_order_items").select("unit_price").eq("id", itemId).single();
    expect(Number((item as { unit_price: number }).unit_price)).toBe(8000); // 10: proposed price dipertahankan

    const { data: req } = await service.from("special_price_approval_requests").select("status, decided_by, decision_reason").eq("id", approvalRequestId).single();
    const r = req as { status: string; decided_by: string; decision_reason: string | null };
    expect(r.status).toBe("APPROVED");
    expect(r.decided_by).toBe(authIds.ownerA);

    const { data: kpi } = await service.from("sales_kpi_achievement_events").select("id").eq("order_id", orderId);
    expect(kpi).toHaveLength(0); // 26: tidak ada KPI
  });

  it("2+12+13+14+26. Owner tenant sama: REJECT PENDING -> restore ke master, totals recalculated, products.price tidak berubah, tidak ada KPI", async () => {
    const { orderId, itemId, approvalRequestId } = await makePendingProposal("p2", "salesA1", customerIds.A, companyA, 10000, 7500, 4);

    const row = await callDecide("ownerA", approvalRequestId, "REJECT", nextIdemKey(), "Diskon terlalu besar");
    expect(row.result_outcome).toBe("rejected");
    expect(row.decision).toBe("REJECTED");
    expect(row.order_status).toBe("draft");

    const { data: item } = await service.from("sales_order_items").select("unit_price, total_amount, discount_amount").eq("id", itemId).single();
    const it = item as { unit_price: number; total_amount: number; discount_amount: number };
    expect(Number(it.unit_price)).toBe(10000); // 12: restore ke master
    expect(Number(it.total_amount)).toBe(4 * 10000 - Number(it.discount_amount)); // 13: recompute

    const { data: order } = await service.from("sales_orders").select("status, total_amount, tax_amount, final_amount, discount_amount").eq("id", orderId).single();
    const o = order as { status: string; total_amount: number; tax_amount: number; final_amount: number; discount_amount: number };
    expect(o.status).toBe("draft");
    expect(Number(o.total_amount)).toBe(40000);
    expect(Number(o.tax_amount)).toBe(Math.round((40000 - Number(o.discount_amount)) * 0.11 * 100) / 100);
    expect(Number(o.final_amount)).toBe(40000 - Number(o.discount_amount) + Number(o.tax_amount));

    const { data: product } = await service.from("products").select("price").eq("id", productIds.p2).single();
    expect(Number((product as { price: number }).price)).toBe(10000); // 14: master price tidak berubah

    const { data: kpi } = await service.from("sales_kpi_achievement_events").select("id").eq("order_id", orderId);
    expect(kpi).toHaveLength(0); // 26

    const { data: audit } = await service.from("audit_logs").select("action, outcome").eq("entity_id", approvalRequestId).eq("action", "order.special_price_proposal_rejected");
    expect(audit).toHaveLength(1);
    expect((audit as any[])[0].outcome).toBe("success");
  });

  it("3+4+5. Admin/Sales/Manager (non-owner strict) ditolak", async () => {
    const { approvalRequestId } = await makePendingProposal("p3", "salesA1", customerIds.A, companyA);
    for (const actor of ["adminA", "salesA1", "managerA"]) {
      const row = await callDecide(actor, approvalRequestId, "APPROVE", nextIdemKey());
      expect(row.result_outcome).toBe("forbidden");
    }
    // Request tetap PENDING -- tidak ada actor non-owner yang berhasil mendecide.
    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("PENDING");
  });

  it("6. Owner tenant lain ditolak tanpa information leak (not_found)", async () => {
    const { approvalRequestId } = await makePendingProposal("p4", "salesA1", customerIds.A, companyA);
    const row = await callDecide("ownerB", approvalRequestId, "APPROVE", nextIdemKey());
    expect(row.result_outcome).toBe("not_found");
  });

  it("7. Unauthenticated ditolak", async () => {
    const { approvalRequestId } = await makePendingProposal("p5", "salesA1", customerIds.A, companyA);
    const anon = createServiceClient(env!.url, env!.anonKey);
    const { data, error } = await anon.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: approvalRequestId,
      p_decision: "APPROVE",
      p_idempotency_key: nextIdemKey(),
      p_decision_reason: null,
    });
    if (error) {
      expect(error.message.toLowerCase()).toContain("permission denied");
    } else {
      expect((data as DecideRow[])[0].result_outcome).toBe("unauthenticated");
    }
  });

  it("8. Request non-PENDING (sudah decided) ditolak fail-closed dengan key baru", async () => {
    const { approvalRequestId } = await makePendingProposal("p6", "salesA1", customerIds.A, companyA);
    const first = await callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey());
    expect(first.result_outcome).toBe("approved");

    const second = await callDecide("ownerA", approvalRequestId, "REJECT", nextIdemKey(), "coba ubah keputusan");
    expect(second.result_outcome).toBe("already_decided");
    expect(second.decision).toBe("APPROVED"); // keputusan asli tidak berubah

    const { data: req } = await service.from("special_price_approval_requests").select("status, decision_reason").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("APPROVED"); // tidak ter-flip ke REJECTED
  });

  it("9. Order yang bukan pending_owner_approval ditolak (invalid_order_state), tanpa mutasi", async () => {
    const { orderId, approvalRequestId } = await makePendingProposal("p7", "salesA1", customerIds.A, companyA);
    // Simulasikan state korup/pre-existing bug (bukan jalur RPC normal) --
    // service_role bypass total untuk membuktikan RPC fail-closed terhadap
    // ketidaksesuaian order status vs request PENDING.
    await service.from("sales_orders").update({ status: "draft" }).eq("id", orderId);

    const row = await callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey());
    expect(row.result_outcome).toBe("invalid_order_state");

    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("PENDING"); // tidak ada mutasi
  });

  it("15. REJECT tanpa alasan ditolak tanpa partial mutation", async () => {
    const { orderId, itemId, approvalRequestId } = await makePendingProposal("p8", "salesA1", customerIds.A, companyA);

    const row = await callDecide("ownerA", approvalRequestId, "REJECT", nextIdemKey(), "   ");
    expect(row.result_outcome).toBe("reason_required");

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("pending_owner_approval");
    const { data: item } = await service.from("sales_order_items").select("unit_price").eq("id", itemId).single();
    expect(Number((item as { unit_price: number }).unit_price)).toBe(8000); // masih proposed, belum direstore
    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("PENDING");
  });

  it("16+23. Snapshot/current-line mismatch ditolak fail-closed (defense-in-depth), tanpa mutasi apa pun", async () => {
    const { orderId, itemId, approvalRequestId } = await makePendingProposal("p9", "salesA1", customerIds.A, companyA, 10000, 8000);
    // Manipulasi langsung (service_role bypass) -- tidak ada jalur RPC normal
    // yang bisa mengubah item selama pending_owner_approval (lihat preflight
    // #4 migration), ini membuktikan RPC tetap fail-closed bila terjadi.
    await service.from("sales_order_items").update({ unit_price: 8888 }).eq("id", itemId);

    const row = await callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey());
    expect(row.result_outcome).toBe("snapshot_mismatch");

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("pending_owner_approval"); // tidak berubah
    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("PENDING"); // tidak berubah
    const { data: item } = await service.from("sales_order_items").select("unit_price").eq("id", itemId).single();
    expect(Number((item as { unit_price: number }).unit_price)).toBe(8888); // tidak disentuh RPC (masih nilai tamper)
  });

  it("17. Exact retry APPROVE (key+payload sama) idempotent, tanpa audit ganda", async () => {
    const { approvalRequestId } = await makePendingProposal("p10", "salesA1", customerIds.A, companyA);
    const key = nextIdemKey();

    const first = await callDecide("ownerA", approvalRequestId, "APPROVE", key);
    expect(first.result_outcome).toBe("approved");

    const retry = await callDecide("ownerA", approvalRequestId, "APPROVE", key);
    expect(retry.result_outcome).toBe("already_decided");
    expect(retry.decision).toBe("APPROVED");
    expect(retry.approval_request_id).toBe(approvalRequestId);

    const { data: audit } = await service.from("audit_logs").select("id").eq("entity_id", approvalRequestId).eq("action", "order.special_price_proposal_approved");
    expect(audit).toHaveLength(1); // tidak dobel
  });

  it("18. Exact retry REJECT (key+payload sama) idempotent, tanpa audit ganda", async () => {
    const { approvalRequestId } = await makePendingProposal("p11", "salesA1", customerIds.A, companyA);
    const key = nextIdemKey();

    const first = await callDecide("ownerA", approvalRequestId, "REJECT", key, "alasan reject");
    expect(first.result_outcome).toBe("rejected");

    const retry = await callDecide("ownerA", approvalRequestId, "REJECT", key, "alasan reject");
    expect(retry.result_outcome).toBe("already_decided");
    expect(retry.decision).toBe("REJECTED");

    const { data: audit } = await service.from("audit_logs").select("id").eq("entity_id", approvalRequestId).eq("action", "order.special_price_proposal_rejected");
    expect(audit).toHaveLength(1);
  });

  it("19+20. Retry key sama, payload/keputusan beda -> idempotency_conflict, keputusan asli tidak tertimpa", async () => {
    const proposalA = await makePendingProposal("p1", "salesA1", customerIds.A, companyA, 10000, 8000);
    const key = nextIdemKey();

    const first = await callDecide("ownerA", proposalA.approvalRequestId, "REJECT", key, "alasan A");
    expect(first.result_outcome).toBe("rejected");

    // 19: keputusan berbeda (APPROVE) dengan key sama, request SUDAH berbeda
    // (non-PENDING) -- request-status check menang lebih dulu (already_decided),
    // BUKAN idempotency_conflict, karena short-circuit lookup key sudah
    // menemukan baris yang SAMA (payload beda -> harusnya idempotency_conflict).
    // Verifikasi: payload (decision+reason) beda dengan key sama pada request
    // yang SAMA -> idempotency_conflict, TANPA mengubah keputusan REJECTED asli.
    const conflictSameRequest = await callDecide("ownerA", proposalA.approvalRequestId, "APPROVE", key, "coba ubah");
    expect(conflictSameRequest.result_outcome).toBe("idempotency_conflict");

    const { data: reqA } = await service.from("special_price_approval_requests").select("status, decision_reason").eq("id", proposalA.approvalRequestId).single();
    const ra = reqA as { status: string; decision_reason: string };
    expect(ra.status).toBe("REJECTED");
    expect(ra.decision_reason).toBe("alasan A"); // tidak tertimpa "coba ubah"

    // 20: key sama dipakai pada REQUEST BERBEDA (payload beda karena
    // approval_request_id ikut fingerprint) -> idempotency_conflict juga,
    // TIDAK memutuskan request kedua ini sama sekali.
    const proposalB = await makePendingProposal("p2", "salesA1", customerIds.A, companyA, 10000, 7000);
    const conflictOtherRequest = await callDecide("ownerA", proposalB.approvalRequestId, "REJECT", key, "alasan A");
    expect(conflictOtherRequest.result_outcome).toBe("idempotency_conflict");

    const { data: reqB } = await service.from("special_price_approval_requests").select("status").eq("id", proposalB.approvalRequestId).single();
    expect((reqB as { status: string }).status).toBe("PENDING"); // request kedua tidak terpengaruh sama sekali
  });

  it("21. Concurrent APPROVE vs REJECT untuk request yang sama -> tepat satu keputusan final, loser fail-closed", async () => {
    const { orderId, approvalRequestId } = await makePendingProposal("p3", "salesA1", customerIds.A, companyA);

    const [r1, r2] = await Promise.all([
      callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey()),
      callDecide("ownerA", approvalRequestId, "REJECT", nextIdemKey(), "concurrent reject"),
    ]);

    // Tepat satu outcome sukses (approved/rejected), satu already_decided --
    // dan keduanya SEPAKAT pada keputusan final yang sama (tidak ada split-brain).
    const finalDecisions = new Set([r1, r2].map((r) => r.decision).filter(Boolean));
    expect(finalDecisions.size).toBe(1);
    const successCount = [r1, r2].filter((r) => r.result_outcome === "approved" || r.result_outcome === "rejected").length;
    const alreadyCount = [r1, r2].filter((r) => r.result_outcome === "already_decided").length;
    expect(successCount).toBe(1);
    expect(alreadyCount).toBe(1);

    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    const finalStatus = (req as { status: string }).status;
    expect(["APPROVED", "REJECTED"]).toContain(finalStatus);

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft"); // kedua keputusan sama-sama -> draft
  });

  it("22. Keputusan final tidak dapat diedit/dibalik/dihapus direct-client (authenticated)", async () => {
    const { approvalRequestId } = await makePendingProposal("p4", "salesA1", customerIds.A, companyA);
    await callDecide("ownerA", approvalRequestId, "APPROVE", nextIdemKey());

    const ownerClient = await signIn("ownerA");
    const { error: updateErr } = await ownerClient.from("special_price_approval_requests").update({ status: "REJECTED" }).eq("id", approvalRequestId);
    expect(updateErr).toBeTruthy();

    const { error: deleteErr } = await ownerClient.from("special_price_approval_requests").delete().eq("id", approvalRequestId);
    expect(deleteErr).toBeTruthy();

    const { data: req } = await service.from("special_price_approval_requests").select("status").eq("id", approvalRequestId).single();
    expect((req as { status: string }).status).toBe("APPROVED"); // tidak berubah
  });

  it("invalid_decision: nilai selain APPROVE/REJECT ditolak", async () => {
    const { approvalRequestId } = await makePendingProposal("p5", "salesA1", customerIds.A, companyA);
    const row = await callDecide("ownerA", approvalRequestId, "MAYBE", nextIdemKey());
    expect(row.result_outcome).toBe("invalid_decision");
  });

  it("invalid_idempotency_key: key kosong/blank ditolak", async () => {
    const { approvalRequestId } = await makePendingProposal("p6", "salesA1", customerIds.A, companyA);
    const row = await callDecide("ownerA", approvalRequestId, "APPROVE", "   ");
    expect(row.result_outcome).toBe("invalid_idempotency_key");
  });

  it("not_found: approval_request_id acak ditolak fail-closed", async () => {
    const scoped = await signIn("ownerA");
    const { data, error } = await scoped.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: randomUUID(),
      p_decision: "APPROVE",
      p_idempotency_key: nextIdemKey(),
      p_decision_reason: null,
    });
    if (error) throw new Error(error.message);
    expect((data as DecideRow[])[0].result_outcome).toBe("not_found");
  });

  it("Gap-fix: order dengan DUA baris item ber-product_id SAMA -- REJECT memulihkan baris yang TEPAT (sales_order_item_id, bukan product_id semata)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "dup", quantity: 2, unitPrice: 20000 },
      { productKey: "dup", quantity: 5, unitPrice: 20000 },
    ]);
    const row = await callSubmit("salesA1", orderId, [
      { sales_order_item_id: itemIds[0], proposed_unit_price: 15000 },
      { sales_order_item_id: itemIds[1], proposed_unit_price: 12000 },
    ], "dua baris produk sama");
    expect(row.result_outcome).toBe("submitted");

    const decideRow = await callDecide("ownerA", row.approval_request_id!, "REJECT", nextIdemKey(), "tolak keduanya");
    expect(decideRow.result_outcome).toBe("rejected");

    const { data: items } = await service.from("sales_order_items").select("id, unit_price").in("id", itemIds);
    for (const it of items as { id: string; unit_price: number }[]) {
      expect(Number(it.unit_price)).toBe(20000); // KEDUA baris pulih ke master masing-masing, tidak tertukar
    }
  });

  it("24+25+28. Regresi: draft update dan confirm normal (tanpa proposal) tetap PASS", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [
      { productKey: "p1", quantity: 5, unitPrice: 10000 },
    ]);

    const { data: updateResult, error: updateErr } = await service.rpc("update_sales_order_atomic", {
      p_company_id: companyA,
      p_actor_id: authIds.salesA1,
      p_order_id: orderId,
      p_customer_id: customerIds.A,
      p_sales_id: authIds.salesA1,
      p_notes: "regression check C3",
      p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [{ product_id: productIds.p1, quantity: 5, unit_price: 10000, discount_amount: 0, total_amount: 50000, notes: null }],
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
});
