// =============================================================================
// Gate 3E-D4-C4 -- Confirmation Enforcement & KPI Boundary, DB-backed
// (Postgres/Supabase NYATA, bukan mock). Membuktikan migration
// 20260926000001_gate_3e_d4_c4_confirmation_enforcement_kpi_boundary.sql
// terhadap kontrak Gate 3E-D4-C4: confirm_sales_order_atomic menolak order
// pending_owner_approval/request PENDING/proposal REJECTED-masih-dipakai/
// APPROVED-tapi-stale, hanya mengizinkan confirm sah (draft tanpa riwayat
// approval, ATAU riwayat approval yang identik current state), KPI
// ORDER_COUNT/REVENUE tepat sekali hanya setelah confirm sah, idempotency
// retry, concurrency, dan bahwa update_sales_order_status_atomic (jalur
// generik yang sesungguhnya dipanggil tombol "Konfirmasi" web dashboard)
// tidak lagi bisa mencapai status confirmed sama sekali.
//
// RPC submit/decide dipanggil lewat sesi Supabase Auth SUNGGUHAN (pola
// identik test C2/C3) -- confirm_sales_order_atomic/
// update_sales_order_status_atomic dipanggil lewat client SERVICE-ROLE
// (pola trusted-caller existing, sama seperti actions.integration.test.ts).
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
  console.warn("Gate 3E-D4-C4 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
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

type ConfirmRow = {
  result_outcome: string;
  already_confirmed: boolean | null;
};

type ProposedLine = { sales_order_item_id: string; proposed_unit_price: number };

describeIfDb("Gate 3E-D4-C4: confirm_sales_order_atomic() enforcement (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
    const orderNumber = `SO-G3ED4C4-${runTag}-${orderIds.length}`;
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

  async function callConfirm(companyId: string, actorId: string, orderId: string, paymentTermsDays: number | null = null): Promise<ConfirmRow> {
    const { data, error } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_id: orderId, p_payment_terms_days: paymentTermsDays,
    });
    if (error) throw new Error(`confirm rpc error: ${error.message}`);
    return (data as ConfirmRow[])[0];
  }

  async function callUpdateStatus(companyId: string, actorId: string, orderId: string, newStatus: string): Promise<{ result_outcome: string }> {
    const { data, error } = await service.rpc("update_sales_order_status_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_id: orderId, p_new_status: newStatus,
    });
    if (error) throw new Error(`update_status rpc error: ${error.message}`);
    return (data as { result_outcome: string }[])[0];
  }

  async function kpiCreditedCount(orderId: string, kpiCode: "ORDER_COUNT" | "REVENUE"): Promise<number> {
    const { count } = await service.from("sales_kpi_achievement_events").select("id", { count: "exact", head: true })
      .eq("order_id", orderId).eq("kpi_code", kpiCode).eq("event_type", "CREDITED");
    return count ?? 0;
  }

  async function auditCount(orderId: string, action: string): Promise<number> {
    const { count } = await service.from("audit_logs").select("id", { count: "exact", head: true })
      .eq("entity_id", orderId).eq("action", action);
    return count ?? 0;
  }

  let idemCounter = 0;
  function nextIdemKey(): string {
    idemCounter += 1;
    return `idem-decide-${runTag}-${idemCounter}`;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C4 A ${runTag}`, slug: `g3ed4c4-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C4 B ${runTag}`, slug: `g3ed4c4-b-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("salesA1", companyA, "sales");
    await makeUser("driverA", companyA, "driver");
    await makeUser("ownerB", companyB, "owner");
    await makeUser("salesB1", companyB, "sales");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerIds.A = (cA as { id: string }).id;
    const { data: cB } = await service.from("customers").insert({ company_id: companyB, code: `CB-${runTag}`, name: "Toko B", assigned_sales_id: authIds.salesB1 }).select("id").single();
    customerIds.B = (cB as { id: string }).id;

    for (const key of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12"]) {
      await makeProduct(key, companyA, 100000);
    }
    await makeProduct("b1", companyB, 100000);
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

  it("1. Normal draft tanpa riwayat special price -> confirm sukses, KPI ORDER_COUNT=1 & REVENUE=final_amount tepat sekali", async () => {
    const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p1", quantity: 2, unitPrice: 100000 }]);
    const { data: orderBefore } = await service.from("sales_orders").select("final_amount").eq("id", orderId).single();
    const finalAmount = Number((orderBefore as { final_amount: number }).final_amount);

    const row = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(row.result_outcome).toBe("confirmed");
    expect(row.already_confirmed).toBe(false);

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("confirmed");

    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(1);

    const { data: revenueEvent } = await service.from("sales_kpi_achievement_events").select("value, salesperson_id")
      .eq("order_id", orderId).eq("kpi_code", "REVENUE").eq("event_type", "CREDITED").single();
    expect(Number((revenueEvent as { value: number }).value)).toBe(finalAmount);
    // 10: attribution Sales berasal dari order.sales_id, BUKAN p_actor_id caller (ownerA yang memanggil confirm).
    expect((revenueEvent as { salesperson_id: string }).salesperson_id).toBe(authIds.salesA1);
  });

  it("2. pending_owner_approval -> ditolak (invalid_order_state), status tidak berubah, KPI 0", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p2", quantity: 1, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 40000 }], "diskon besar butuh approval");
    expect(submitRow.result_outcome).toBe("submitted");
    expect(submitRow.order_status).toBe("pending_owner_approval");

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("invalid_order_state");

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("pending_owner_approval");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(0);
  });

  it("3. Request PENDING tersisa (anomali/defense-in-depth) -> ditolak (pending_approval_exists) walau status order sudah draft, KPI 0", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p3", quantity: 1, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 40000 }], "alasan");
    expect(submitRow.result_outcome).toBe("submitted");

    // Simulasi anomali: paksa order kembali ke draft lewat service-role SAMBIL
    // request PENDING dibiarkan ada (tidak mungkin lewat RPC normal -- defense-
    // in-depth murni, membuktikan Guard 2 bekerja independen dari Guard 1).
    await service.from("sales_orders").update({ status: "draft" }).eq("id", orderId);

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("pending_approval_exists");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
  });

  it("4a. REJECTED dan sudah direstore ke master price -> confirm sukses normal (bukan blocker permanen)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p4", quantity: 1, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 40000 }], "alasan reject");
    const decideRow = await callDecide("ownerA", submitRow.approval_request_id!, "REJECT", nextIdemKey(), "harga terlalu rendah");
    expect(decideRow.result_outcome).toBe("rejected");

    const { data: item } = await service.from("sales_order_items").select("unit_price").eq("id", itemIds[0]).single();
    expect(Number((item as { unit_price: number }).unit_price)).toBe(100000); // restore terbukti

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("confirmed");
  });

  it("4b. REJECTED tapi harga khusus MASIH dipakai (restore dilewati via jalur lain, simulasi) -> ditolak (unapproved_special_price), KPI 0", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p5", quantity: 1, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 40000 }], "alasan reject 2");
    const decideRow = await callDecide("ownerA", submitRow.approval_request_id!, "REJECT", nextIdemKey(), "harga terlalu rendah 2");
    expect(decideRow.result_outcome).toBe("rejected");

    // Simulasi bug/bypass di jalur lain: harga khusus dipaksa kembali aktif
    // SETELAH restore (tidak mungkin lewat update_sales_order_atomic normal
    // karena FK sales_order_item_id -- murni defense-in-depth di confirm).
    await service.from("sales_order_items").update({ unit_price: 40000 }).eq("id", itemIds[0]);

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("unapproved_special_price");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft");
  });

  it("5+6. APPROVED dan snapshot cocok -> confirm sukses; APPROVE saja (belum confirm) TIDAK menambah KPI", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p6", quantity: 3, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 60000 }], "alasan approve");
    const decideRow = await callDecide("ownerA", submitRow.approval_request_id!, "APPROVE", nextIdemKey());
    expect(decideRow.result_outcome).toBe("approved");
    expect(decideRow.order_status).toBe("draft");

    // 6: APPROVE saja belum confirm, belum KPI.
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
    const { data: orderMid } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((orderMid as { status: string }).status).toBe("draft");

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(1);
  });

  it("7. Item dimutasi (harga lebih rendah lagi) SETELAH APPROVE, SEBELUM confirm -> ditolak (approval_snapshot_mismatch), KPI 0", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p7", quantity: 2, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 60000 }], "alasan mismatch price");
    await callDecide("ownerA", submitRow.approval_request_id!, "APPROVE", nextIdemKey());

    // Mutasi item setelah approve (simulasi -- update_sales_order_atomic akan
    // gagal FK constraint pada order dengan riwayat approval, jadi mutasi ini
    // menguji defense-in-depth confirm secara independen dari jalur itu).
    await service.from("sales_order_items").update({ unit_price: 50000 }).eq("id", itemIds[0]);

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("approval_snapshot_mismatch");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);
  });

  it("7b. Quantity dimutasi (harga TETAP sama) SETELAH APPROVE -> tetap ditolak (approval_snapshot_mismatch)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p8", quantity: 2, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 60000 }], "alasan mismatch qty");
    await callDecide("ownerA", submitRow.approval_request_id!, "APPROVE", nextIdemKey());

    await service.from("sales_order_items").update({ quantity: 3 }).eq("id", itemIds[0]);

    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("approval_snapshot_mismatch");
  });

  it("8. Approval order LAIN pada tenant yang SAMA tidak bisa 'dipinjam' -- order tanpa riwayat approval sendiri confirm normal (tidak salah baca approval order lain)", async () => {
    const { orderId: approvedOrderId, itemIds: approvedItems } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p9", quantity: 1, unitPrice: 100000 }]);
    const submitRow = await callSubmit("salesA1", approvedOrderId, [{ sales_order_item_id: approvedItems[0], proposed_unit_price: 60000 }], "alasan order A");
    await callDecide("ownerA", submitRow.approval_request_id!, "APPROVE", nextIdemKey());

    const { orderId: otherOrderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p10", quantity: 1, unitPrice: 100000 }]);
    const otherConfirm = await callConfirm(companyA, authIds.ownerA, otherOrderId);
    expect(otherConfirm.result_outcome).toBe("confirmed"); // order lain, tidak terpengaruh riwayat approval order pertama

    // Order dengan approval sendiri tetap confirm sukses (approval-nya sendiri, bukan "dipinjam").
    const approvedConfirm = await callConfirm(companyA, authIds.ownerA, approvedOrderId);
    expect(approvedConfirm.result_outcome).toBe("confirmed");
  });

  it("9. Stale: proposal_version lebih baru (REJECTED) ada, tapi item masih mencerminkan versi LAMA yang approved -> ditolak (unapproved_special_price)", async () => {
    const { orderId, itemIds } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p11", quantity: 1, unitPrice: 100000 }]);
    const v1 = await callSubmit("salesA1", orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: 70000 }], "v1 alasan");
    await callDecide("ownerA", v1.approval_request_id!, "APPROVE", nextIdemKey());
    // item sekarang di 70000, matches v1 approved snapshot.

    // Simulasikan versi 2 REJECTED sudah tercatat (mis. Sales mengajukan lagi
    // lalu Owner reject) TAPI item TIDAK sempat direstore ke master (anomali
    // yang dibuktikan defense-in-depth, bukan jalur normal) -- proposal_version
    // TERTINGGI (v2) sekarang menentukan, BUKAN v1 yang approved tapi stale.
    // Trigger invariant mewajibkan INSERT awal berstatus PENDING (transisi ke
    // REJECTED hanya lewat UPDATE terpisah) -- dua langkah, bukan satu INSERT.
    const { data: v2Row, error: v2Err } = await service.from("special_price_approval_requests").insert({
      company_id: companyA, sales_order_id: orderId, proposal_version: 2, status: "PENDING",
      requested_by: authIds.salesA1, order_snapshot_hash: `hash-v2-${runTag}`,
    }).select("id").single();
    if (v2Err) throw new Error(`gagal insert v2: ${v2Err.message}`);
    const v2Id = (v2Row as { id: string }).id;
    approvalRequestIds.push(v2Id);
    const { error: v2LineErr } = await service.from("special_price_approval_lines").insert({
      approval_request_id: v2Id, line_number: 1, product_id: productIds.p11, product_name_snapshot: "Produk p11",
      quantity: 1, master_unit_price: 100000, proposed_unit_price: 65000, effective_floor_unit_price: 0,
      sales_order_item_id: itemIds[0],
    });
    if (v2LineErr) throw new Error(`gagal insert v2 line: ${v2LineErr.message}`);

    const { error: v2DecideErr } = await service.from("special_price_approval_requests").update({
      status: "REJECTED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(), decision_reason: "v2 reject",
    }).eq("id", v2Id);
    if (v2DecideErr) throw new Error(`gagal update v2 ke REJECTED: ${v2DecideErr.message}`);

    // Latest = v2 (REJECTED) -- item wajib match master_unit_price (100000)
    // untuk v2, tapi item masih 70000 (dari v1) -> unapproved_special_price.
    const confirmRow = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmRow.result_outcome).toBe("unapproved_special_price");
  });

  it("11. caller non-authorized (user tidak aktif pada tenant) -> ditolak (forbidden), master product price tidak berubah", async () => {
    const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p12", quantity: 1, unitPrice: 100000 }]);
    const { data: before } = await service.from("products").select("price").eq("id", productIds.p12).single();

    const fakeActorId = randomUUID(); // tidak terdaftar sebagai users row aktif di companyA
    const confirmRow = await callConfirm(companyA, fakeActorId, orderId);
    expect(confirmRow.result_outcome).toBe("forbidden");

    const { data: after } = await service.from("products").select("price").eq("id", productIds.p12).single();
    expect(Number((after as { price: number }).price)).toBe(Number((before as { price: number }).price));

    // cross-tenant: order companyA dikonfirmasi dengan p_company_id companyB -> not_found (tenant-scoped lookup)
    const crossTenant = await callConfirm(companyB, authIds.ownerB, orderId);
    expect(crossTenant.result_outcome).toBe("not_found");

    // caller sah, tenant benar -> tetap bisa confirm normal setelahnya
    const okConfirm = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(okConfirm.result_outcome).toBe("confirmed");
  });

  it("12+13. Retry identik -> hasil konsisten (already_confirmed), tidak ada KPI/audit ganda; retry payload berbeda (payment_terms_days lain) tidak diam-diam menimpa", async () => {
    const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p1", quantity: 1, unitPrice: 100000 }]);
    const first = await callConfirm(companyA, authIds.ownerA, orderId, 14);
    expect(first.result_outcome).toBe("confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await auditCount(orderId, "order.confirm")).toBe(1);

    const retrySame = await callConfirm(companyA, authIds.ownerA, orderId, 14);
    expect(retrySame.result_outcome).toBe("already_confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(1);
    expect(await auditCount(orderId, "order.confirm")).toBe(1);

    const retryDifferentPayload = await callConfirm(companyA, authIds.ownerA, orderId, 30);
    expect(retryDifferentPayload.result_outcome).toBe("already_confirmed");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await auditCount(orderId, "order.confirm")).toBe(1);

    const { data: order } = await service.from("sales_orders").select("payment_terms_days").eq("id", orderId).single();
    expect((order as { payment_terms_days: number | null }).payment_terms_days).toBe(14); // retry payload beda tidak menimpa
  });

  it("14. Concurrent confirm untuk order yang sama -> tepat satu confirmation dan satu set KPI", async () => {
    const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p2", quantity: 1, unitPrice: 100000 }]);

    const [r1, r2] = await Promise.all([
      callConfirm(companyA, authIds.ownerA, orderId),
      callConfirm(companyA, authIds.ownerA, orderId),
    ]);
    const outcomes = [r1.result_outcome, r2.result_outcome].sort();
    expect(outcomes).toEqual(["already_confirmed", "confirmed"].sort());

    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(1);
    expect(await kpiCreditedCount(orderId, "REVENUE")).toBe(1);
    expect(await auditCount(orderId, "order.confirm")).toBe(1);
  });

  it("15. update_sales_order_status_atomic (jalur generik tombol 'Konfirmasi' web) TIDAK LAGI bisa mencapai status confirmed sama sekali", async () => {
    const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "p3", quantity: 1, unitPrice: 100000 }]);

    const row = await callUpdateStatus(companyA, authIds.ownerA, orderId, "confirmed");
    expect(row.result_outcome).toBe("confirmation_workflow_required");

    const { data: order } = await service.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft");
    expect(await kpiCreditedCount(orderId, "ORDER_COUNT")).toBe(0);

    // Order yang SUDAH confirmed (lewat jalur canonical) tetap bisa lanjut
    // lifecycle non-confirmation lewat RPC generik ini (draft->confirmed
    // TIDAK boleh, tapi confirmed->processing tetap harus jalan normal).
    const confirmed = await callConfirm(companyA, authIds.ownerA, orderId);
    expect(confirmed.result_outcome).toBe("confirmed");
    const toProcessing = await callUpdateStatus(companyA, authIds.ownerA, orderId, "processing");
    expect(toProcessing.result_outcome).toBe("updated");
  });
});
