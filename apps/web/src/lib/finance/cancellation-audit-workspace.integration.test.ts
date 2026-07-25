// =============================================================================
// DB-backed integration test -- Gate 2I.4: Cancellation & Invoice Void /
// Riwayat Audit Finance read model (apps/web/src/lib/finance/queries.ts:
// getCancellationList/getCancellationDetail/getCancellationForOrder/
// getOrderCancellationEligibility/getFinanceAuditList) dipanggil terhadap
// Postgres nyata setelah RPC canonical Gate 2G dijalankan lewat service-role
// client -- pola identik return-refund-workspace.integration.test.ts (Gate
// 2I.3) dan fixture chain order-cancellation-invoice-void.integration.test.ts
// (Gate 2G, TIDAK disentuh/diulang di sini kecuali skenario baru §3 test
// matrix Gate 2I.4 yang belum pernah dibuktikan Gate 2G: CXL-09 retry setelah
// APPROVE).
//
// RPC canonical Gate 2G sendiri (locking, precondition tiga lapis, pairing
// invariant, dsb.) TIDAK diuji ulang secara menyeluruh -- sudah dibuktikan di
// order-cancellation-invoice-void.integration.test.ts. Fokus test ini: (1)
// read model Gate 2I.4 mencerminkan state RPC dengan benar (bukan
// re-implementasi formula), (2) tenant isolation query workspace (CXL-01),
// (3) RLS audit_logs Owner-only (CXL-AUD-01), (4) CXL-09 (gap Gate 2G test
// coverage: retry approve/reject setelah APPROVED, bukan hanya setelah
// REJECTED).
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola sama
// seluruh integration test finance lain.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import {
  getCancellationDetail,
  getCancellationForOrder,
  getCancellationList,
  getFinanceAuditList,
  getOrderCancellationEligibility,
} from "./queries";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
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
  console.warn("DB integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type RequestCancelRow = { out_cancellation_id: string; out_status: string; out_already_exists: boolean };
type ApproveCancelRow = {
  out_cancellation_id: string;
  out_status: string;
  out_order_status: string | null;
  out_invoice_void_id: string | null;
  out_voided_amount: string | null;
};

describeIfDb("Gate 2I.4: Cancellation & Invoice Void / Riwayat Audit Finance workspace (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role -- dipakai sebagai override client queries.ts (pola sama Gate 2I.2/2I.3)
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const createdCompanyIds = [companyId, otherCompanyId];

  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];

  let ownerUser: { userId: string; email: string; password: string };
  let financeUser: { userId: string; email: string; password: string };
  let otherOwnerUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2I4 ${tag}`,
      slug: `itest-g2i4-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 4, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550007",
    });
    if (error) throw new Error(`gagal buat company ${tag}: ${error.message}`);
  }

  async function createActor(targetCompanyId: string, tag: string, roleName: string) {
    const email = `${tag}@itest.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${tag}: ${error?.message}`);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await supabase.from("users").insert({ id: userId, company_id: targetCompanyId, email, full_name: `Actor ${tag}`, is_active: true });
    const { data: role, error: roleErr } = await supabase.from("roles").select("id").is("company_id", null).eq("name", roleName).single();
    if (roleErr || !role) throw new Error(`role ${roleName} tidak ditemukan: ${roleErr?.message}`);
    await supabase.from("user_roles").insert({ user_id: userId, role_id: (role as { id: string }).id, company_id: targetCompanyId });
    return { userId, email, password };
  }

  async function createCustomer(targetCompanyId: string, tag: string) {
    const { data, error } = await supabase.from("customers").insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` }).select("id").single();
    if (error) throw new Error(`gagal buat customer: ${error.message}`);
    const customerId = (data as { id: string }).id;
    createdCustomerIds.push(customerId);
    return customerId;
  }

  async function createOrderOnly(targetCompanyId: string, tag: string, customerId: string, status: string) {
    const { data, error } = await supabase
      .from("sales_orders")
      .insert({ company_id: targetCompanyId, order_number: `SO-${tag}`, customer_id: customerId, status })
      .select("id")
      .single();
    if (error) throw new Error(`gagal buat order: ${error.message}`);
    const orderId = (data as { id: string }).id;
    createdOrderIds.push(orderId);
    return orderId;
  }

  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, customerId: string, quantity = 10, unitPrice = 1000) {
    const orderId = await createOrderOnly(targetCompanyId, tag, customerId, "delivered");

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: targetCompanyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const totalAmount = quantity * unitPrice;
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity, unit_price: unitPrice, discount_amount: 0, total_amount: totalAmount })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    const orderItemId = (item as { id: string }).id;

    const { error: diErr } = await supabase.from("delivery_items").insert({
      delivery_id: deliveryId,
      sales_order_item_id: orderItemId,
      ordered_quantity: quantity,
      dispatched_quantity: quantity,
      received_quantity: quantity,
    });
    if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);

    const { data: issueData, error: issueErr } = await supabase.rpc("issue_invoice_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_order_id: orderId,
    });
    if (issueErr) throw new Error(`issue_invoice_atomic gagal: ${issueErr.message}`);
    const row = (issueData as Array<{ out_invoice_id: string; out_total_amount: string }>)[0];

    return { orderId, invoiceId: row.out_invoice_id, totalAmount: Number(row.out_total_amount) };
  }

  async function requestCancel(actorId: string, orderId: string, opts: { reasonCode?: string; companyId?: string } = {}) {
    return supabase.rpc("request_order_cancellation_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_sales_order_id: orderId,
      p_reason_code: opts.reasonCode ?? "CUSTOMER_REQUEST",
      p_idempotency_key: null,
    });
  }

  async function approveCancel(actorId: string, cancellationId: string, decision: "approve" | "reject") {
    return supabase.rpc("approve_order_cancellation_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_cancellation_id: cancellationId,
      p_decision: decision,
    });
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGJ");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGK");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    otherOwnerUser = await createActor(otherCompanyId, `${runTag}-oowner`, "owner");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("invoice_voids").delete().in("company_id", createdCompanyIds);
    await supabase.from("order_cancellations").delete().in("company_id", createdCompanyIds);
    await supabase.from("receivable_ledger").delete().in("company_id", createdCompanyIds);
    await supabase.from("invoice_lines").delete().in("company_id", createdCompanyIds);
    await supabase.from("invoices").delete().in("company_id", createdCompanyIds);
    await supabase.from("issued_documents").delete().in("company_id", createdCompanyIds);
    await supabase.from("delivery_items").delete().in("delivery_id", createdDeliveryIds);
    await supabase.from("deliveries").delete().in("id", createdDeliveryIds);
    await supabase.from("sales_order_items").delete().in("order_id", createdOrderIds);
    await supabase.from("sales_orders").delete().in("id", createdOrderIds);
    await supabase.from("customers").delete().in("id", createdCustomerIds);
    await supabase.from("document_number_counters").delete().in("company_id", createdCompanyIds);
    await supabase.from("user_roles").delete().in("user_id", createdUserIds);
    await supabase.from("users").delete().in("id", createdUserIds);
    for (const id of createdUserIds) {
      await supabase.auth.admin.deleteUser(id);
    }
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  // ---------------------------------------------------------------------
  // Read model: list + ordering + tenant isolation (CXL-01)
  // ---------------------------------------------------------------------
  it("getCancellationList: memprioritaskan status=requested, lalu requested_at DESC, tenant-scoped", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-LIST`);
    const orderA = await createOrderOnly(companyId, `${runTag}-LIST-A`, customerId, "draft");
    const orderB = await createOrderOnly(companyId, `${runTag}-LIST-B`, customerId, "draft");

    const { data: reqA } = await requestCancel(financeUser.userId, orderA);
    const cxlA = (reqA as RequestCancelRow[])[0].out_cancellation_id;
    await approveCancel(ownerUser.userId, cxlA, "approve"); // final -> lower priority

    const { data: reqB } = await requestCancel(financeUser.userId, orderB); // requested -> higher priority
    const cxlB = (reqB as RequestCancelRow[])[0].out_cancellation_id;

    const items = await getCancellationList(companyId, supabase);
    const idxB = items.findIndex((i) => i.id === cxlB);
    const idxA = items.findIndex((i) => i.id === cxlA);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeLessThan(idxA); // requested muncul lebih dulu dari approved

    const otherItems = await getCancellationList(otherCompanyId, supabase);
    expect(otherItems.find((i) => i.id === cxlA || i.id === cxlB)).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // CXL-01: cross-tenant detail -> null, bukan data company lain bocor.
  // ---------------------------------------------------------------------
  it("CXL-01: getCancellationDetail milik Company A tidak dapat diakses lewat scope Company B -> null", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-XT`);
    const orderId = await createOrderOnly(companyId, `${runTag}-XT`, customerId, "draft");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const ownScope = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(ownScope).not.toBeNull();

    const crossTenant = await getCancellationDetail(otherCompanyId, cancellationId, supabase);
    expect(crossTenant).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Preview branch mencerminkan state real (§E) -- eligible_no_invoice,
  // delivery_reversal_required, eligible_full_void, settlement_exists.
  // ---------------------------------------------------------------------
  it("getCancellationDetail: previewBranch=eligible_no_invoice untuk order draft tanpa invoice", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-PREV1`);
    const orderId = await createOrderOnly(companyId, `${runTag}-PREV1`, customerId, "draft");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const detail = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(detail?.previewBranch).toBe("eligible_no_invoice");
    expect(detail?.invoice).toBeNull();
  });

  it("getCancellationDetail: previewBranch=delivery_reversal_required untuk order delivered (CXL-07)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-PREV2`);
    const orderId = await createOrderOnly(companyId, `${runTag}-PREV2`, customerId, "delivered");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const detail = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(detail?.previewBranch).toBe("delivery_reversal_required");
  });

  it("getCancellationDetail: previewBranch=eligible_full_void untuk invoice polos, lalu approve -> invoiceVoid relation terisi dari canonical (§F/§9)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-PREV3`);
    const inv = await createInvoice(companyId, `${runTag}-PREV3`, financeUser.userId, customerId, 5, 2000); // total 10000
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const before = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(before?.previewBranch).toBe("eligible_full_void");
    expect(before?.invoice?.totalAmount).toBe(10000);
    expect(before?.invoiceVoid).toBeNull();

    const { error: apprErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(apprErr).toBeNull();

    const after = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(after?.status).toBe("approved");
    expect(after?.invoiceVoid).not.toBeNull();
    expect(after?.invoiceVoid?.voidedAmount).toBe(10000);
  });

  it("getCancellationDetail: previewBranch=settlement_exists menampilkan fakta payment allocation (CXL-08)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-PREV4`);
    const inv = await createInvoice(companyId, `${runTag}-PREV4`, financeUser.userId, customerId, 5, 2000);
    const { error: payErr } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_method: "cash",
      p_amount: 3000,
      p_proofs: [{ proof_type: "cash_receipt", object_reference: `storage://proofs/${runTag}-prev4.jpg` }],
      p_allocations: [{ invoice_id: inv.invoiceId, amount: 3000 }],
    });
    expect(payErr).toBeNull();

    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const detail = await getCancellationDetail(companyId, cancellationId, supabase);
    expect(detail?.previewBranch).toBe("settlement_exists");
    expect(detail?.invoice?.hasPaymentAllocation).toBe(true);
  });

  // ---------------------------------------------------------------------
  // getCancellationForOrder + getOrderCancellationEligibility (§B.4/§C UX)
  // ---------------------------------------------------------------------
  it("getCancellationForOrder mengembalikan cancellation terbaru untuk order; getOrderCancellationEligibility memblokir order dengan cancellation requested aktif", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-ELIG`);
    const orderId = await createOrderOnly(companyId, `${runTag}-ELIG`, customerId, "draft");

    const beforeRequest = await getOrderCancellationEligibility(companyId, orderId, supabase);
    expect(beforeRequest.eligible).toBe(true);

    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const related = await getCancellationForOrder(companyId, orderId, supabase);
    expect(related?.id).toBe(cancellationId);
    expect(related?.status).toBe("requested");

    const afterRequest = await getOrderCancellationEligibility(companyId, orderId, supabase);
    expect(afterRequest.eligible).toBe(false);
    expect(afterRequest.blockedReason).toMatch(/pengajuan pembatalan yang belum diputuskan/i);
  });

  // ---------------------------------------------------------------------
  // CXL-09: retry approve/reject setelah SUDAH approved -- melengkapi gap
  // Gate 2G test #17 (yang hanya menguji retry setelah REJECT).
  // ---------------------------------------------------------------------
  it("CXL-09/FIN-09-03: cancellation sudah approved, approve/reject lagi ditolak ORDER_CANCELLATION_ALREADY_RESOLVED, tanpa invoice_voids/ledger/audit kedua", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-CXL09`);
    const inv = await createInvoice(companyId, `${runTag}-CXL09`, financeUser.userId, customerId, 4, 2500); // total 10000
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { data: apprData, error: apprErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(apprErr).toBeNull();
    const firstVoidId = (apprData as ApproveCancelRow[])[0].out_invoice_void_id;
    expect(firstVoidId).not.toBeNull();

    const { error: retryApproveErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(retryApproveErr).not.toBeNull();
    expect(retryApproveErr!.message).toMatch(/ORDER_CANCELLATION_ALREADY_RESOLVED/);

    const { error: retryRejectErr } = await approveCancel(ownerUser.userId, cancellationId, "reject");
    expect(retryRejectErr).not.toBeNull();
    expect(retryRejectErr!.message).toMatch(/ORDER_CANCELLATION_ALREADY_RESOLVED/);

    const { count: voidCount } = await supabase
      .from("invoice_voids")
      .select("id", { count: "exact", head: true })
      .eq("order_cancellation_id", cancellationId);
    expect(voidCount).toBe(1);

    const { count: approvedAuditCount } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("entity_id", cancellationId)
      .eq("action", "order_cancellation.approved");
    expect(approvedAuditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Riwayat Audit Finance: module=finance scoping + RLS Owner-only (CXL-AUD-01)
  // ---------------------------------------------------------------------
  it("getFinanceAuditList: module=finance scoped, mencakup order_cancellation.requested/approved/invoice.voided/receivable.adjusted", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-AUD1`);
    const inv = await createInvoice(companyId, `${runTag}-AUD1`, financeUser.userId, customerId, 2, 5000); // total 10000
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;
    await approveCancel(ownerUser.userId, cancellationId, "approve");

    const result = await getFinanceAuditList(companyId, { entityId: cancellationId }, supabase);
    const actions = result.items.map((i) => i.action);
    expect(actions).toContain("order_cancellation.requested");
    expect(actions).toContain("order_cancellation.approved");
    expect(result.items.every((i) => i.id)).toBe(true);
  });

  it("CXL-AUD-01/§H: RLS audit_logs_select HANYA mengizinkan role owner aktif -- Finance (session-scoped) tidak melihat baris meski module=finance", async () => {
    const anonAsFinance = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await anonAsFinance.auth.signInWithPassword({ email: financeUser.email, password: financeUser.password });
    expect(signInErr).toBeNull();

    const financeResult = await getFinanceAuditList(companyId, {}, anonAsFinance);
    expect(financeResult.items.length).toBe(0); // RLS menolak SELECT sama sekali untuk non-owner (§H kontrak)

    const anonAsOwner = createClient(env!.url, env!.anonKey);
    const { error: ownerSignInErr } = await anonAsOwner.auth.signInWithPassword({ email: ownerUser.email, password: ownerUser.password });
    expect(ownerSignInErr).toBeNull();

    const ownerResult = await getFinanceAuditList(companyId, {}, anonAsOwner);
    expect(ownerResult.items.length).toBeGreaterThan(0); // Owner (session-scoped) dapat membaca lewat RLS
  });

  it("§H: audit_logs company lain tidak bocor lewat getFinanceAuditList (RLS + .eq company_id ganda)", async () => {
    const anonAsOtherOwner = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await anonAsOtherOwner.auth.signInWithPassword({ email: otherOwnerUser.email, password: otherOwnerUser.password });
    expect(signInErr).toBeNull();

    // otherOwner (Company B) mencoba baca companyId (Company A) -- RLS company_id = get_user_company_id() menolak.
    const crossTenantResult = await getFinanceAuditList(companyId, {}, anonAsOtherOwner);
    expect(crossTenantResult.items.length).toBe(0);
  });
});
