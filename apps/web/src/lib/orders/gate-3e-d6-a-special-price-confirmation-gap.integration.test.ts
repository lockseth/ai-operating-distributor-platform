// =============================================================================
// Gate 3E-D6-A -- Special Price Approval Enforcement, DB-backed (Postgres/
// Supabase NYATA). Reproduksi bypass LIVE yang dibuktikan
// docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md (§5-§7): order yang
// dibuat lewat create_sales_order_atomic/update_sales_order_atomic (satu-
// satunya jalur order web aktif) dengan unit_price < products.price (harga
// khusus) berhasil confirm_sales_order_atomic TANPA PERNAH memanggil
// submit_special_price_proposal_atomic sama sekali (TIDAK ADA baris
// special_price_approval_requests) -- karena Guard 3 lama HANYA memvalidasi
// riwayat approval "IF FOUND", dilewati total bila riwayat tidak pernah ada.
// KPI ORDER_COUNT/REVENUE ikut terkredit dari harga yang tidak pernah
// disetujui Owner.
//
// Test ini dijalankan SEBELUM migration Gate 3E-D6-A (harus GAGAL, membuktikan
// bug nyata) dan SESUDAH migration Gate 3E-D6-A (harus LOLOS, membuktikan
// fix). RPC create/update_sales_order_atomic dipanggil lewat client SERVICE-
// ROLE (pola identik actions.ts/getAdminClient()) -- persis jalur produksi
// nyata, BUKAN direct insert ke sales_orders.
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
  console.warn("Gate 3E-D6-A integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type CreateRow = { result_outcome: string; result_order_id: string | null };
type ConfirmRow = { result_outcome: string; already_confirmed: boolean | null };
type SubmitRow = { result_outcome: string; requires_approval: boolean | null; approval_request_id: string | null };

describeIfDb("Gate 3E-D6-A: special-price approval enforcement closes confirm_sales_order_atomic gap (DB-backed)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed6a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const productIds: Record<string, string> = {};
  let customerId: string;
  const orderIds: string[] = [];
  const policyIds: string[] = [];
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

  async function makeProduct(key: string, price: number): Promise<string> {
    const { data, error } = await service.from("products").insert({ company_id: companyA, sku: `SKU-${key}-${runTag}`, name: `Produk ${key}`, price, is_active: true }).select("id").single();
    if (error) throw new Error(`gagal buat produk ${key}: ${error.message}`);
    productIds[key] = (data as { id: string }).id;
    return productIds[key];
  }

  async function callCreate(items: { productKey: string; quantity: number; unitPrice: number }[]): Promise<CreateRow> {
    const orderNumber = `SO-G3ED6A-${runTag}-${orderIds.length}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyA,
      p_actor_id: authIds.ownerA,
      p_order_number: orderNumber,
      p_customer_id: customerId,
      p_sales_id: authIds.salesA1,
      p_notes: null,
      p_delivery_date: null,
      p_discount_amount: 0,
      p_items: items.map((it) => ({
        product_id: productIds[it.productKey], quantity: it.quantity, unit_price: it.unitPrice,
        discount_amount: 0, total_amount: it.quantity * it.unitPrice, notes: null,
      })),
    });
    if (error) throw new Error(`create rpc error: ${error.message}`);
    const row = (data as CreateRow[])[0];
    if (row.result_order_id) orderIds.push(row.result_order_id);
    return row;
  }

  async function callConfirm(orderId: string): Promise<ConfirmRow> {
    const { data, error } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyA, p_actor_id: authIds.ownerA, p_order_id: orderId, p_payment_terms_days: null,
    });
    if (error) throw new Error(`confirm rpc error: ${error.message}`);
    return (data as ConfirmRow[])[0];
  }

  async function orderItemIds(orderId: string): Promise<string[]> {
    const { data } = await service.from("sales_order_items").select("id").eq("order_id", orderId).order("id");
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  async function callSubmit(orderId: string, items: { sales_order_item_id: string; proposed_unit_price: number }[], reason: string): Promise<SubmitRow> {
    const scoped = await signIn("salesA1");
    const { data, error } = await scoped.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId, p_items: items, p_reason: reason, p_idempotency_key: null,
    });
    if (error) throw new Error(`submit rpc error: ${error.message}`);
    const row = (data as SubmitRow[])[0];
    if (row.approval_request_id) approvalRequestIds.push(row.approval_request_id);
    return row;
  }

  async function callDecide(approvalRequestId: string, decision: string, idemKey: string): Promise<{ result_outcome: string }> {
    const scoped = await signIn("ownerA");
    const { data, error } = await scoped.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: approvalRequestId, p_decision: decision, p_idempotency_key: idemKey, p_decision_reason: decision === "REJECT" ? "alasan reject" : null,
    });
    if (error) throw new Error(`decide rpc error: ${error.message}`);
    return (data as { result_outcome: string }[])[0];
  }

  async function kpiCreditedCount(orderId: string, kpiCode: "ORDER_COUNT" | "REVENUE"): Promise<number> {
    const { count } = await service.from("sales_kpi_achievement_events").select("id", { count: "exact", head: true })
      .eq("order_id", orderId).eq("kpi_code", kpiCode).eq("event_type", "CREDITED");
    return count ?? 0;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companyErr } = await service.from("companies").insert({ id: companyA, name: `Gate 3E-D6-A ${runTag}`, slug: `g3ed6a-${runTag}` });
    if (companyErr) throw new Error(`gagal buat company: ${companyErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("salesA1", companyA, "sales");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko G3ED6A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerId = (cA as { id: string }).id;

    for (const key of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
      await makeProduct(key, 100000);
    }
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
    await service.from("knowledge_discount_policies").delete().in("id", policyIds);
    await service.from("products").delete().in("id", Object.values(productIds));
    await service.from("customers").delete().eq("id", customerId);
    await service.from("user_roles").delete().eq("company_id", companyA);
    const allIds = Object.values(authIds);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().eq("id", companyA);
    for (const id of allIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1. [ROOT BUG] Order dibuat via create_sales_order_atomic dengan unit_price << products.price, TIDAK PERNAH submit_special_price_proposal_atomic -> confirm HARUS ditolak, KPI 0", async () => {
    const created = await callCreate([{ productKey: "p1", quantity: 10, unitPrice: 5000 }]); // master 100000, diskon 95%
    expect(created.result_outcome).toBe("created");
    const orderId = created.result_order_id!;

    // Bukti: TIDAK ADA riwayat approval sama sekali untuk order ini.
    const { count: approvalCount } = await service.from("special_price_approval_requests").select("id", { count: "exact", head: true }).eq("sales_order_id", orderId);
    expect(approvalCount).toBe(0);

    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("unapproved_special_price");

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).not.toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(0);
  });

  it("2. Order harga normal (unit_price = products.price) via create_sales_order_atomic -> confirm tetap sukses (tidak regresi)", async () => {
    const created = await callCreate([{ productKey: "p2", quantity: 3, unitPrice: 100000 }]);
    const orderId = created.result_order_id!;
    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
  });

  it("3. Diskon DALAM batas knowledge_discount_policies aktif (product-scope) -> confirm sukses TANPA approval (bukan harga khusus)", async () => {
    const { data: pol, error } = await service.from("knowledge_discount_policies").insert({
      company_id: companyA, scope: "product", product_id: productIds.p3, max_percentage: 20, is_active: true,
    }).select("id").single();
    if (error) throw new Error(error.message);
    policyIds.push((pol as { id: string }).id);

    const created = await callCreate([{ productKey: "p3", quantity: 1, unitPrice: 85000 }]); // diskon 15%, dalam batas 20%
    const orderId = created.result_order_id!;
    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
  });

  it("4. Diskon MELEBIHI batas policy aktif, tanpa submit proposal -> confirm ditolak (unapproved_special_price)", async () => {
    const { data: pol, error } = await service.from("knowledge_discount_policies").insert({
      company_id: companyA, scope: "product", product_id: productIds.p4, max_percentage: 10, is_active: true,
    }).select("id").single();
    if (error) throw new Error(error.message);
    policyIds.push((pol as { id: string }).id);

    const created = await callCreate([{ productKey: "p4", quantity: 1, unitPrice: 50000 }]); // diskon 50%, melebihi batas 10%
    const orderId = created.result_order_id!;
    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("unapproved_special_price");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
  });

  it("5. [COVERAGE GAP] 2 item harga khusus, HANYA 1 diajukan+disetujui Owner, item ke-2 TIDAK PERNAH diajukan -> confirm tetap ditolak (item ke-2 tidak tercakup approval)", async () => {
    const created = await callCreate([
      { productKey: "p5", quantity: 1, unitPrice: 40000 },
      { productKey: "p6", quantity: 1, unitPrice: 45000 },
    ]);
    const orderId = created.result_order_id!;
    const items = await orderItemIds(orderId);

    const submitRow = await callSubmit(orderId, [{ sales_order_item_id: items[0], proposed_unit_price: 40000 }], "hanya item pertama diajukan");
    expect(submitRow.result_outcome).toBe("submitted");
    await callDecide(submitRow.approval_request_id!, "APPROVE", `idem-${runTag}-5`);

    // Order kembali draft (APPROVE), item ke-2 (p6, 45000 < master 100000) TIDAK PERNAH diajukan/disetujui.
    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("approval_snapshot_mismatch");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
  });

  it("6. Order dengan harga khusus DAN approval Owner sah mencakup SEMUA line -> confirm sukses, KPI tepat sekali", async () => {
    const created = await callCreate([{ productKey: "p1", quantity: 2, unitPrice: 60000 }]);
    const orderId = created.result_order_id!;
    const items = await orderItemIds(orderId);

    const submitRow = await callSubmit(orderId, [{ sales_order_item_id: items[0], proposed_unit_price: 60000 }], "alasan sah");
    await callDecide(submitRow.approval_request_id!, "APPROVE", `idem-${runTag}-6`);

    const confirmRow = await callConfirm(orderId);
    expect(confirmRow.result_outcome).toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(1);
  });

  it("7. [DIRECT-WRITE BYPASS] Direct-client (authenticated, bukan service-role) tidak bisa memindahkan status ke 'confirmed' lewat UPDATE langsung", async () => {
    const created = await callCreate([{ productKey: "p2", quantity: 1, unitPrice: 100000 }]);
    const orderId = created.result_order_id!;

    const scopedOwner = await signIn("ownerA");
    const { data, error } = await scopedOwner.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).select("id");

    // RLS WITH CHECK menolak baris -- baik lewat error 42501 eksplisit ATAU
    // 0 baris ter-update (keduanya berarti update ditolak).
    if (!error) {
      expect((data ?? []).length).toBe(0);
    } else {
      expect(error).toBeTruthy();
    }

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
  });

  it("8. [DIRECT-WRITE BYPASS] Direct-client tidak bisa INSERT order baru langsung berstatus 'confirmed'", async () => {
    const scopedOwner = await signIn("ownerA");
    const orderNumber = `SO-G3ED6A-DIRECT-${runTag}`;
    const { data, error } = await scopedOwner.from("sales_orders").insert({
      company_id: companyA, order_number: orderNumber, customer_id: customerId, sales_id: authIds.salesA1,
      status: "confirmed", total_amount: 1, final_amount: 1,
    }).select("id");

    // WITH CHECK RLS harus menolak (baik lewat error RLS eksplisit ATAU 0 baris -- keduanya berarti insert gagal).
    if (!error) {
      expect((data ?? []).length).toBe(0);
    } else {
      expect(error).toBeTruthy();
    }

    const { count } = await service.from("sales_orders").select("id", { count: "exact", head: true }).eq("order_number", orderNumber);
    expect(count).toBe(0);
  });
});
