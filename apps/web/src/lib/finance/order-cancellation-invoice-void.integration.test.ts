// =============================================================================
// DB-backed integration test -- Gate 2G: Order Cancellation & Invoice Void
// (supabase/migrations/20260901000001_order_cancellation_invoice_void.sql).
//
// Membuktikan: pembatalan order tanpa invoice (langsung, tanpa ledger) vs
// order dengan invoice issued-untouched (request -> approve Owner -> invoice
// void + ledger credit compensating) vs invoice yang sudah tersentuh
// (payment/credit note/outstanding berubah -> ditolak, di luar scope) vs
// order dengan delivery final tanpa invoice (ditolak, butuh inventory
// reversal). Invoice void BUKAN retur/credit note/customer credit/refund.
// Skip graceful jika kredensial Supabase lokal tidak tersedia atau URL bukan
// loopback -- pola sama gate finance sebelumnya.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260901000001_order_cancellation_invoice_void.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB).
// ---------------------------------------------------------------------------
describe("Gate 2G -- static proof atomicity & vocabulary (migration 20260901000001)", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8");

  function extractFunctionBody(fnName: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
    expect(start, `function public.${fnName} tidak ditemukan di migration`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf("$$ LANGUAGE plpgsql", start);
    expect(end, `penutup $$ LANGUAGE plpgsql untuk ${fnName} tidak ditemukan`).toBeGreaterThan(start);
    return migration.slice(start, end);
  }

  it("tidak ada identifier test-only (_test_) atau trigger failure-injection di migration produksi", () => {
    expect(migration).not.toMatch(/_test_/i);
    expect(migration).not.toMatch(/TEST_FORCED_ROLLBACK/);
    expect(migration).not.toMatch(/CREATE TRIGGER trg_test_/i);
  });

  it("kedua RPC adalah SATU function body tanpa blok EXCEPTION (kegagalan selalu rollback penuh)", () => {
    expect(extractFunctionBody("request_order_cancellation_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(extractFunctionBody("approve_order_cancellation_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("kedua RPC terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sig1 = "public.request_order_cancellation_atomic(UUID, UUID, UUID, TEXT, TEXT)";
    const sig2 = "public.approve_order_cancellation_atomic(UUID, UUID, UUID, TEXT)";
    for (const sig of [sig1, sig2]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`);
    }
  });

  it("izin order_cancellation.approve HANYA digrant ke owner (bukan manager/admin/super_admin/finance)", () => {
    expect(migration).toContain("AND r.name = 'owner'\n  AND p.name = 'order_cancellation.approve'");
  });

  it("izin order_cancellation.request digrant ke owner/manager/admin/super_admin/finance (bukan sales)", () => {
    expect(migration).toContain("AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')\n  AND p.name = 'order_cancellation.request'");
  });

  it("order_cancellations hanya mengizinkan transisi status requested->approved|rejected (bukan append-only penuh)", () => {
    expect(migration).toContain("ORDER_CANCELLATION_ALREADY_RESOLVED");
    expect(migration).toContain("ORDER_CANCELLATION_INVALID_TRANSITION");
  });

  it("invoice_voids immutable penuh (tidak ada transisi status)", () => {
    expect(migration).toContain("INVOICE_VOID_IMMUTABLE");
  });

  it("invoice_voids.invoice_id DAN order_cancellation_id UNIQUE -- satu invoice satu void, 1:1 dengan cancellation", () => {
    expect(migration).toContain("order_cancellation_id  UUID          NOT NULL UNIQUE REFERENCES public.order_cancellations");
    expect(migration).toContain("invoice_id             UUID          NOT NULL UNIQUE REFERENCES public.invoices");
  });

  it("uq_order_cancellations_one_approved_per_order -- satu approved cancellation per order secara struktural", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX uq_order_cancellations_one_approved_per_order");
  });

  it("pairing invariant DEFERRED menutup celah orphan invoice_void ledger", () => {
    expect(migration).toContain("trg_receivable_ledger_invoice_void_pairing");
    expect(migration).toContain("ORPHAN_INVOICE_VOID_LEDGER_CREDIT");
  });

  it("Customer Credit Ledger/Refund TIDAK diimplementasikan (di luar scope Gate 2G)", () => {
    expect(migration).not.toMatch(/customer_credit_ledger/i);
    expect(migration).not.toMatch(/CREATE TABLE.*refund/i);
  });
});

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

interface InvoiceFixture {
  companyId: string;
  customerId: string;
  orderId: string;
  invoiceId: string;
  totalAmount: number;
  lineId: string;
}

type RequestCancelRow = { out_cancellation_id: string; out_status: string; out_already_exists: boolean };
type ApproveCancelRow = {
  out_cancellation_id: string;
  out_status: string;
  out_order_status: string | null;
  out_invoice_void_id: string | null;
  out_voided_amount: string | null;
};

describeIfDb("Gate 2G: Order Cancellation & Invoice Void (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const createdCompanyIds = [companyId, otherCompanyId];

  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdLedgerIds: string[] = []; // orphan-insert probe cleanup (test 15)

  let ownerUser: { userId: string; email: string; password: string };
  let financeUser: { userId: string; email: string; password: string };
  let inactiveOwnerUser: { userId: string; email: string; password: string };
  let otherOwnerUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2G ${tag}`,
      slug: `itest-g2g-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 2, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550006",
    });
    if (error) throw new Error(`gagal buat company ${tag}: ${error.message}`);
  }

  async function createActor(targetCompanyId: string, tag: string, roleName: string, isActive = true) {
    const email = `${tag}@itest.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${tag}: ${error?.message}`);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await supabase.from("users").insert({ id: userId, company_id: targetCompanyId, email, full_name: `Actor ${tag}`, is_active: isActive });
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

  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, customerId: string, quantity = 10, unitPrice = 1000): Promise<InvoiceFixture> {
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

    const { data: line, error: lineErr } = await supabase.from("invoice_lines").select("id").eq("invoice_id", row.out_invoice_id).single();
    if (lineErr) throw new Error(`gagal ambil invoice_line: ${lineErr.message}`);

    return {
      companyId: targetCompanyId,
      customerId,
      orderId,
      invoiceId: row.out_invoice_id,
      totalAmount: Number(row.out_total_amount),
      lineId: (line as { id: string }).id,
    };
  }

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string) {
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_method: "cash",
      p_amount: amount,
      p_proofs: [{ proof_type: "cash_receipt", object_reference: `storage://proofs/${ref}.jpg` }],
      p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
  }

  async function issueCreditNote(actorId: string, invoiceId: string, lineId: string, quantity: number) {
    const { data: reqData, error: reqErr } = await supabase.rpc("request_return_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_invoice_id: invoiceId,
      p_items: [{ invoice_line_id: lineId, requested_quantity: quantity }],
      p_reason_code: "DAMAGED_GOODS",
      p_proof_reference: `storage://return-proofs/${randomUUID()}.jpg`,
      p_idempotency_key: null,
    });
    if (reqErr) throw new Error(`request_return_atomic gagal: ${reqErr.message}`);
    const returnId = (reqData as Array<{ out_return_id: string }>)[0].out_return_id;
    const { error: verErr } = await supabase.rpc("verify_return_atomic", {
      p_company_id: companyId,
      p_actor_id: ownerUser.userId, // return.verify Owner-only
      p_return_id: returnId,
      p_decision: "approve",
    });
    if (verErr) throw new Error(`verify_return_atomic gagal: ${verErr.message}`);
  }

  async function requestCancel(actorId: string, orderId: string, opts: { reasonCode?: string; companyId?: string; idempotencyKey?: string } = {}) {
    return supabase.rpc("request_order_cancellation_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_sales_order_id: orderId,
      p_reason_code: opts.reasonCode ?? "CUSTOMER_REQUEST",
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function approveCancel(actorId: string, cancellationId: string, decision: "approve" | "reject", opts: { companyId?: string } = {}) {
    return supabase.rpc("approve_order_cancellation_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_cancellation_id: cancellationId,
      p_decision: decision,
    });
  }

  async function balanceOf(invoiceId: string) {
    const { data } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", invoiceId).single();
    return data as { outstanding_balance: string; financial_status: string; total_debit: string; total_credit: string };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGH");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGI");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    inactiveOwnerUser = await createActor(companyId, `${runTag}-inactive-owner`, "owner", false);
    otherOwnerUser = await createActor(otherCompanyId, `${runTag}-oowner`, "owner");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("invoice_voids").delete().in("company_id", createdCompanyIds);
    await supabase.from("order_cancellations").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_reversals").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_lines").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_notes").delete().in("company_id", createdCompanyIds);
    await supabase.from("return_items").delete().in("company_id", createdCompanyIds);
    await supabase.from("returns").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_allocations").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_proofs").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_receipts").delete().in("company_id", createdCompanyIds);
    if (createdLedgerIds.length > 0) {
      await supabase.from("receivable_ledger").delete().in("id", createdLedgerIds);
    }
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
  // 1. Order tanpa invoice dapat dibatalkan langsung, TANPA ledger entry.
  // ---------------------------------------------------------------------
  it("1. Order tanpa invoice (draft) dapat dibatalkan via request->approve, TANPA ledger entry", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-NOINV`);
    const orderId = await createOrderOnly(companyId, `${runTag}-NOINV`, customerId, "draft");

    const { data: reqData, error: reqErr } = await requestCancel(financeUser.userId, orderId);
    expect(reqErr).toBeNull();
    const reqRow = (reqData as RequestCancelRow[])[0];
    expect(reqRow.out_status).toBe("requested");

    const { data: apprData, error: apprErr } = await approveCancel(ownerUser.userId, reqRow.out_cancellation_id, "approve");
    expect(apprErr).toBeNull();
    const apprRow = (apprData as ApproveCancelRow[])[0];
    expect(apprRow.out_status).toBe("approved");
    expect(apprRow.out_order_status).toBe("cancelled");
    expect(apprRow.out_invoice_void_id).toBeNull();

    const { data: order } = await supabase.from("sales_orders").select("status").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("cancelled");

    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("order_cancellation_id", reqRow.out_cancellation_id);
    expect(voidCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 2. Approval hanya oleh Owner.
  // ---------------------------------------------------------------------
  it("2. Approval order_cancellation HANYA oleh Owner (finance ditolak FORBIDDEN)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-OWNERONLY`);
    const orderId = await createOrderOnly(companyId, `${runTag}-OWNERONLY`, customerId, "draft");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error: financeErr } = await approveCancel(financeUser.userId, cancellationId, "approve");
    expect(financeErr).not.toBeNull();
    expect(financeErr!.message).toMatch(/FORBIDDEN/);

    const { error: inactiveErr } = await approveCancel(inactiveOwnerUser.userId, cancellationId, "approve");
    expect(inactiveErr).not.toBeNull();
    expect(inactiveErr!.message).toMatch(/FORBIDDEN/);

    const { error: ownerErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(ownerErr).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 3. Invoice issued dan untouched dapat di-void; ledger credit compensating
  //    tepat mengimbangi invoice debit; histori invoice/ledger lama tetap
  //    immutable.
  // ---------------------------------------------------------------------
  it("3. Invoice untouched di-void penuh -- ledger credit tepat mengimbangi debit, histori lama immutable", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-VOID`);
    const inv = await createInvoice(companyId, `${runTag}-VOID`, financeUser.userId, customerId, 10, 1000); // total 10000
    const before = await balanceOf(inv.invoiceId);
    expect(Number(before.outstanding_balance)).toBe(10000);

    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { data: apprData, error: apprErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(apprErr).toBeNull();
    const apprRow = (apprData as ApproveCancelRow[])[0];
    expect(apprRow.out_order_status).toBe("cancelled");
    expect(apprRow.out_invoice_void_id).not.toBeNull();
    expect(Number(apprRow.out_voided_amount)).toBe(10000);

    const after = await balanceOf(inv.invoiceId);
    expect(Number(after.outstanding_balance)).toBe(0);
    expect(after.financial_status).toBe("paid");

    // Ledger lama (invoice_issued) tetap ada, plus SATU baris baru invoice_void.
    const { count: issuedCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_issued");
    expect(issuedCount).toBe(1);
    const { count: voidLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_void");
    expect(voidLedgerCount).toBe(1);

    // Invoice row asli tidak berubah (immutable) -- total_amount tetap sama.
    const { data: invRow } = await supabase.from("invoices").select("total_amount").eq("id", inv.invoiceId).single();
    expect(Number((invRow as { total_amount: string }).total_amount)).toBe(10000);

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderRow as { status: string }).status).toBe("cancelled");
  });

  // ---------------------------------------------------------------------
  // 4. Payment terverifikasi (partial) ditolak.
  // ---------------------------------------------------------------------
  it("4. Invoice dengan payment terverifikasi ditolak (INVOICE_SETTLEMENT_EXISTS), TANPA partial mutation", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-PAID`);
    const inv = await createInvoice(companyId, `${runTag}-PAID`, financeUser.userId, customerId, 10, 1000);
    await pay(financeUser.userId, inv.invoiceId, 4000, `${runTag}-paid-partial`);

    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVOICE_SETTLEMENT_EXISTS/);

    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(0);
    const { count: voidLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_void");
    expect(voidLedgerCount).toBe(0);
    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderRow as { status: string }).status).toBe("invoiced");
    const { data: cancellationRow } = await supabase.from("order_cancellations").select("status").eq("id", cancellationId).single();
    expect((cancellationRow as { status: string }).status).toBe("requested");
  });

  // ---------------------------------------------------------------------
  // 5. Active credit note ditolak, TANPA membuat customer credit/refund baru.
  // ---------------------------------------------------------------------
  it("5. Invoice dengan credit note aktif ditolak (INVOICE_SETTLEMENT_EXISTS)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-CN`);
    const inv = await createInvoice(companyId, `${runTag}-CN`, financeUser.userId, customerId, 10, 1000);
    await issueCreditNote(financeUser.userId, inv.invoiceId, inv.lineId, 2);

    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVOICE_SETTLEMENT_EXISTS/);

    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 6. Order dengan delivery final (delivered) tanpa invoice ditolak.
  // ---------------------------------------------------------------------
  it("6. Order berstatus delivered (delivery final) tanpa invoice ditolak (DELIVERY_REVERSAL_REQUIRED)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-DELIVERED`);
    const orderId = await createOrderOnly(companyId, `${runTag}-DELIVERED`, customerId, "delivered");

    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/DELIVERY_REVERSAL_REQUIRED/);

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", orderId).single();
    expect((orderRow as { status: string }).status).toBe("delivered");
  });

  // ---------------------------------------------------------------------
  // 7. Duplicate/retry idempotent pada request (idempotency_key).
  // ---------------------------------------------------------------------
  it("7. Retry request_order_cancellation_atomic dengan idempotency_key SAMA tidak menggandakan", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-IDEMP`);
    const orderId = await createOrderOnly(companyId, `${runTag}-IDEMP`, customerId, "draft");
    const key = `${runTag}-idemp-key`;

    const { data: first, error: firstErr } = await requestCancel(financeUser.userId, orderId, { idempotencyKey: key });
    expect(firstErr).toBeNull();
    const firstRow = (first as RequestCancelRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    const { data: second, error: secondErr } = await requestCancel(financeUser.userId, orderId, { idempotencyKey: key });
    expect(secondErr).toBeNull();
    const secondRow = (second as RequestCancelRow[])[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_cancellation_id).toBe(firstRow.out_cancellation_id);

    const { count } = await supabase.from("order_cancellations").select("id", { count: "exact", head: true }).eq("sales_order_id", orderId);
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 8. Concurrent/duplicate approval tidak menggandakan invoice_void/ledger.
  // ---------------------------------------------------------------------
  it("8. Concurrent approval pada cancellation yang SAMA hanya menghasilkan SATU invoice_void", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-CONCUR`);
    const inv = await createInvoice(companyId, `${runTag}-CONCUR`, financeUser.userId, customerId, 10, 1000);
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const [r1, r2] = await Promise.allSettled([approveCancel(ownerUser.userId, cancellationId, "approve"), approveCancel(ownerUser.userId, cancellationId, "approve")]);
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].error!.message)).toMatch(/ORDER_CANCELLATION_ALREADY_RESOLVED/);

    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(1);
    const { count: voidLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_void");
    expect(voidLedgerCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 9. Cross-tenant access ditolak.
  // ---------------------------------------------------------------------
  it("9. Cross-tenant request/approve ditolak", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-XTENANT`);
    const orderId = await createOrderOnly(companyId, `${runTag}-XTENANT`, customerId, "draft");

    const { error: reqErr } = await requestCancel(otherOwnerUser.userId, orderId);
    expect(reqErr).not.toBeNull();
    expect(reqErr!.message).toMatch(/FORBIDDEN/);

    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error: apprErr } = await approveCancel(otherOwnerUser.userId, cancellationId, "approve");
    expect(apprErr).not.toBeNull();
    expect(apprErr!.message).toMatch(/FORBIDDEN/);
  });

  // ---------------------------------------------------------------------
  // 10. Direct client mutation ditolak.
  // ---------------------------------------------------------------------
  it("10. Direct client insert ke order_cancellations/invoice_voids ditolak (anon/authenticated tidak boleh mutasi)", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const { error: e1 } = await anon.from("order_cancellations").insert({
      company_id: companyId, sales_order_id: randomUUID(), reason_code: "x", requested_by: randomUUID(), request_payload: {},
    });
    expect(e1).not.toBeNull();

    const { error: e2 } = await anon.from("invoice_voids").insert({
      company_id: companyId, order_cancellation_id: randomUUID(), invoice_id: randomUUID(), voided_amount: 1, receivable_ledger_id: randomUUID(), approved_by: randomUUID(),
    });
    expect(e2).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 11. Audit ditulis tepat satu kali.
  // ---------------------------------------------------------------------
  it("11. Audit event order_cancellation.requested/approved, invoice.voided, receivable.adjusted tercatat tepat satu kali", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-AUDIT`);
    const inv = await createInvoice(companyId, `${runTag}-AUDIT`, financeUser.userId, customerId, 10, 1000);
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { count: requestedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "order_cancellation.requested").eq("entity_id", cancellationId);
    expect(requestedAudit).toBe(1);

    const { data: apprData } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    const invoiceVoidId = (apprData as ApproveCancelRow[])[0].out_invoice_void_id!;

    const { count: approvedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "order_cancellation.approved").eq("entity_id", cancellationId);
    expect(approvedAudit).toBe(1);
    const { count: voidedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "invoice.voided").eq("entity_id", invoiceVoidId);
    expect(voidedAudit).toBe(1);
    const { count: adjustedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "receivable.adjusted").contains("new_data", { invoice_void_id: invoiceVoidId });
    expect(adjustedAudit).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 12. Pairing/integrity constraint menolak orphan invoice_void ledger.
  // ---------------------------------------------------------------------
  it("12. Insert bare receivable_ledger entry_type=invoice_void TANPA invoice_voids ditolak (orphan pairing)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-ORPHAN`);
    const inv = await createInvoice(companyId, `${runTag}-ORPHAN`, financeUser.userId, customerId, 10, 1000);

    const { data, error } = await supabase
      .from("receivable_ledger")
      .insert({ company_id: companyId, invoice_id: inv.invoiceId, entry_type: "invoice_void", direction: "credit", amount: inv.totalAmount })
      .select("id")
      .single();
    if (data) createdLedgerIds.push((data as { id: string }).id);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/ORPHAN_INVOICE_VOID_LEDGER_CREDIT/);
  });

  // ---------------------------------------------------------------------
  // 13. Order sudah cancelled tidak dapat diajukan pembatalan lagi.
  // ---------------------------------------------------------------------
  it("13. Order yang sudah cancelled ditolak saat request ulang (ORDER_ALREADY_CANCELLED)", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-ALREADYX`);
    const orderId = await createOrderOnly(companyId, `${runTag}-ALREADYX`, customerId, "draft");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;
    await approveCancel(ownerUser.userId, cancellationId, "approve");

    const { error } = await requestCancel(financeUser.userId, orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/ORDER_ALREADY_CANCELLED/);
  });

  // ---------------------------------------------------------------------
  // 14. Rejection sukses oleh Owner: status rejected, order/invoice tidak
  //     berubah, invoice_voids/receivable_ledger tidak bertambah, audit
  //     order_cancellation.rejected tepat satu kali.
  // ---------------------------------------------------------------------
  it("14. Rejection menandai rejected TANPA invoice_void/ledger entry, invoice tidak berubah, audit tepat satu kali", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-REJECT`);
    const inv = await createInvoice(companyId, `${runTag}-REJECT`, financeUser.userId, customerId, 10, 1000);
    const { data: ledgerBefore } = await supabase.from("receivable_ledger").select("id").eq("invoice_id", inv.invoiceId);
    const ledgerCountBefore = (ledgerBefore ?? []).length;

    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { data, error } = await approveCancel(ownerUser.userId, cancellationId, "reject");
    expect(error).toBeNull();
    const row = (data as ApproveCancelRow[])[0];
    expect(row.out_status).toBe("rejected");
    expect(row.out_invoice_void_id).toBeNull();

    const { data: cancellationRow } = await supabase.from("order_cancellations").select("status, decided_by").eq("id", cancellationId).single();
    expect((cancellationRow as { status: string }).status).toBe("rejected");
    expect((cancellationRow as { decided_by: string | null }).decided_by).toBe(ownerUser.userId);

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderRow as { status: string }).status).toBe("invoiced");

    const { data: invRow } = await supabase.from("invoices").select("total_amount").eq("id", inv.invoiceId).single();
    expect(Number((invRow as { total_amount: string }).total_amount)).toBe(inv.totalAmount);

    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(0);

    const { data: ledgerAfter } = await supabase.from("receivable_ledger").select("id").eq("invoice_id", inv.invoiceId);
    expect((ledgerAfter ?? []).length).toBe(ledgerCountBefore); // hanya opening debit, tidak bertambah

    const { count: rejectedAuditCount } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "order_cancellation.rejected")
      .eq("entity_id", cancellationId);
    expect(rejectedAuditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 15. Non-Owner (finance, tenant yang sama) memanggil reject ditolak
  //     FORBIDDEN, request tetap requested, tanpa side effect apa pun.
  // ---------------------------------------------------------------------
  it("15. Non-Owner (finance) memanggil decision=reject ditolak FORBIDDEN, request tetap requested, TANPA side effect", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-NONOWNERREJ`);
    const inv = await createInvoice(companyId, `${runTag}-NONOWNERREJ`, financeUser.userId, customerId, 10, 1000);
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error } = await approveCancel(financeUser.userId, cancellationId, "reject");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);

    const { data: cancellationRow } = await supabase.from("order_cancellations").select("status, decided_by, decided_at").eq("id", cancellationId).single();
    expect((cancellationRow as { status: string }).status).toBe("requested");
    expect((cancellationRow as { decided_by: string | null }).decided_by).toBeNull();
    expect((cancellationRow as { decided_at: string | null }).decided_at).toBeNull();

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderRow as { status: string }).status).toBe("invoiced");
    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(0);
    const { count: voidLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_void");
    expect(voidLedgerCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 16. Owner tenant A mencoba reject cancellation milik tenant B ditolak
  //     TENANT_CONTEXT_MISMATCH (bukan FORBIDDEN -- actor valid di tenant A,
  //     yang salah adalah cancellation_id lintas tenant); cancellation
  //     tenant B tidak berubah.
  // ---------------------------------------------------------------------
  it("16. Owner tenant A reject cancellation tenant B ditolak TENANT_CONTEXT_MISMATCH, cancellation tenant B tidak berubah", async () => {
    const customerBId = await createCustomer(otherCompanyId, `${runTag}-XTENREJ-B`);
    const orderBId = await createOrderOnly(otherCompanyId, `${runTag}-XTENREJ-B`, customerBId, "draft");
    const { data: reqDataB } = await requestCancel(otherOwnerUser.userId, orderBId, { companyId: otherCompanyId });
    const cancellationBId = (reqDataB as RequestCancelRow[])[0].out_cancellation_id;

    // p_company_id = tenant A (companyId) supaya actor check (ownerUser milik
    // companyId) lolos -- kegagalan HARUS terjadi di tenant check cancellation,
    // bukan di permission check actor.
    const { error } = await approveCancel(ownerUser.userId, cancellationBId, "reject", { companyId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/TENANT_CONTEXT_MISMATCH/);

    const { data: cancellationRow } = await supabase.from("order_cancellations").select("status, company_id, decided_by").eq("id", cancellationBId).single();
    expect((cancellationRow as { status: string }).status).toBe("requested");
    expect((cancellationRow as { company_id: string }).company_id).toBe(otherCompanyId);
    expect((cancellationRow as { decided_by: string | null }).decided_by).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 17. Retry setelah rejection: reject->reject dan reject->approve DITOLAK
  //     ORDER_CANCELLATION_ALREADY_RESOLVED, audit rejected tetap tepat satu,
  //     TANPA invoice_void/ledger/side effect tambahan.
  // ---------------------------------------------------------------------
  it("17. Retry setelah rejection (reject->reject, reject->approve) ditolak ORDER_CANCELLATION_ALREADY_RESOLVED, audit tetap satu", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-RETRYREJ`);
    const inv = await createInvoice(companyId, `${runTag}-RETRYREJ`, financeUser.userId, customerId, 10, 1000);
    const { data: reqData } = await requestCancel(financeUser.userId, inv.orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const { error: firstErr } = await approveCancel(ownerUser.userId, cancellationId, "reject");
    expect(firstErr).toBeNull();

    const { error: retryRejectErr } = await approveCancel(ownerUser.userId, cancellationId, "reject");
    expect(retryRejectErr).not.toBeNull();
    expect(retryRejectErr!.message).toMatch(/ORDER_CANCELLATION_ALREADY_RESOLVED/);

    const { error: retryApproveErr } = await approveCancel(ownerUser.userId, cancellationId, "approve");
    expect(retryApproveErr).not.toBeNull();
    expect(retryApproveErr!.message).toMatch(/ORDER_CANCELLATION_ALREADY_RESOLVED/);

    const { count: rejectedAuditCount } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "order_cancellation.rejected")
      .eq("entity_id", cancellationId);
    expect(rejectedAuditCount).toBe(1);

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderRow as { status: string }).status).toBe("invoiced"); // TIDAK pernah jadi cancelled
    const { count: voidCount } = await supabase.from("invoice_voids").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(voidCount).toBe(0);
    const { count: voidLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "invoice_void");
    expect(voidLedgerCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 18. Direct UPDATE order_cancellations.status='rejected' via client
  //     authenticated dan anon ditolak (REVOKE boundary -- BUKAN service-role).
  // ---------------------------------------------------------------------
  it("18. Direct UPDATE order_cancellations via authenticated/anon ditolak, row tetap requested", async () => {
    const customerId = await createCustomer(companyId, `${runTag}-DIRECTUPD`);
    const orderId = await createOrderOnly(companyId, `${runTag}-DIRECTUPD`, customerId, "draft");
    const { data: reqData } = await requestCancel(financeUser.userId, orderId);
    const cancellationId = (reqData as RequestCancelRow[])[0].out_cancellation_id;

    const authClient = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({ email: financeUser.email, password: financeUser.password });
    expect(signInErr).toBeNull();
    const authUpdate = await authClient.from("order_cancellations").update({ status: "rejected" }).eq("id", cancellationId);
    expect(authUpdate.error).not.toBeNull();
    expect(authUpdate.error!.message).toMatch(/permission denied/i);
    await authClient.auth.signOut();

    const anonClient = createClient(env!.url, env!.anonKey);
    const anonUpdate = await anonClient.from("order_cancellations").update({ status: "rejected" }).eq("id", cancellationId);
    expect(anonUpdate.error).not.toBeNull();
    expect(anonUpdate.error!.message).toMatch(/permission denied/i);

    const { data: cancellationRow } = await supabase.from("order_cancellations").select("status").eq("id", cancellationId).single();
    expect((cancellationRow as { status: string }).status).toBe("requested");
  });
});
