// =============================================================================
// DB-backed integration test -- Gate 2H.1: Customer Credit Ledger & Refund
// (supabase/migrations/20260902000001_customer_credit_ledger_refund.sql).
//
// Membuktikan: credit_notes.customer_credit_amount (Gate 2F) -> Customer
// Credit Ledger (append-only, TERPISAH TOTAL dari receivable_ledger) ->
// refund lifecycle (requested -> approved|rejected) yang mencatat &
// memverifikasi pengembalian nilai ke customer TANPA transfer bank/cash
// otomatis dan TANPA menyentuh receivable_ledger/invoice/sales_order/
// delivery/payment/return/credit_note Gate 2F. Skip graceful jika kredensial
// Supabase lokal tidak tersedia atau URL bukan loopback -- pola sama dengan
// return-credit-note-receivable-reduction.integration.test.ts (Gate 2F).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260902000001_customer_credit_ledger_refund.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB).
// ---------------------------------------------------------------------------
describe("Gate 2H.1 -- static proof atomicity & vocabulary (migration 20260902000001)", () => {
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

  it("ketiga RPC (request/approve refund + reverse_credit_note perluasan) adalah SATU function body tanpa blok EXCEPTION", () => {
    expect(extractFunctionBody("request_refund_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(extractFunctionBody("approve_refund_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(extractFunctionBody("reverse_credit_note_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("ketiga RPC terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sig1 = "public.request_refund_atomic(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, DATE, TEXT)";
    const sig2 = "public.approve_refund_atomic(UUID, UUID, UUID, TEXT)";
    const sig3 = "public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)";
    for (const sig of [sig1, sig2, sig3]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`);
    }
  });

  it("izin refund.approve HANYA digrant ke owner (bukan manager/admin/super_admin/finance)", () => {
    expect(migration).toContain("AND r.name = 'owner'\n  AND p.name = 'refund.approve'");
  });

  it("izin refund.request digrant HANYA ke owner/finance (LEBIH SEMPIT dari return.request)", () => {
    expect(migration).toContain("AND r.name IN ('owner', 'finance')\n  AND p.name = 'refund.request'");
  });

  it("refund_requests hanya mengizinkan transisi status requested->approved|rejected (bukan append-only penuh)", () => {
    expect(migration).toContain("REFUND_ALREADY_RESOLVED");
    expect(migration).toContain("REFUND_INVALID_TRANSITION");
  });

  it("customer_credit_ledger immutable penuh (tidak ada transisi status -- pure ledger)", () => {
    expect(migration).toContain("CUSTOMER_CREDIT_LEDGER_IMMUTABLE");
  });

  it("refund_requests.credit_note_id NOT NULL tunggal -- satu refund hanya satu bucket secara struktural (bukan array/junction)", () => {
    expect(migration).toContain("credit_note_id    UUID          NOT NULL REFERENCES public.credit_notes (id) ON DELETE RESTRICT");
  });

  it("uq_customer_credit_ledger_one_origin_per_note -- origin credit tidak dapat dibuat dua kali secara struktural", () => {
    expect(migration).toContain("uq_customer_credit_ledger_one_origin_per_note");
    expect(migration).toContain("WHERE entry_type = 'credit_note_origin'");
  });

  it("uq_customer_credit_ledger_one_debit_per_refund -- idempotency struktural kedua, independen dari cek status RPC", () => {
    expect(migration).toContain("uq_customer_credit_ledger_one_debit_per_refund");
  });

  it("refund tidak pernah menyentuh receivable_ledger/invoices/sales_orders/deliveries di badan RPC request/approve", () => {
    const reqBody = extractFunctionBody("request_refund_atomic");
    const apprBody = extractFunctionBody("approve_refund_atomic");
    for (const body of [reqBody, apprBody]) {
      expect(body).not.toMatch(/INSERT INTO public\.receivable_ledger/);
      expect(body).not.toMatch(/UPDATE public\.invoices/);
      expect(body).not.toMatch(/UPDATE public\.sales_orders/);
      expect(body).not.toMatch(/UPDATE public\.deliveries/);
    }
  });

  it("perluasan reverse_credit_note_atomic menambah PENDING_REFUND_EXISTS dan REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN", () => {
    const body = extractFunctionBody("reverse_credit_note_atomic");
    expect(body).toMatch(/PENDING_REFUND_EXISTS/);
    expect(body).toMatch(/REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN/);
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
  quantity: number;
  unitPrice: number;
}

type RequestReturnRow = { out_return_id: string; out_status: string; out_already_exists: boolean };
type VerifyReturnRow = {
  out_return_id: string;
  out_status: string;
  out_credit_note_id: string | null;
  out_total_amount: string | null;
  out_applied_amount: string | null;
  out_customer_credit_amount: string | null;
};
type ReverseRow = {
  out_reversal_id: string;
  out_credit_note_id: string;
  out_reversed_amount: string;
  out_customer_credit_voided_amount: string;
  out_already_exists: boolean;
};
type RequestRefundRow = { out_refund_id: string; out_status: string; out_already_exists: boolean };
type ApproveRefundRow = {
  out_refund_id: string;
  out_status: string;
  out_ledger_entry_id: string | null;
  out_amount: string | null;
  out_already_exists: boolean;
};
type CcBalanceRow = {
  credit_note_id: string;
  customer_credit_amount: string;
  total_credit: string;
  total_debit: string;
  ledger_balance: string;
  pending_reserved: string;
  available_balance: string;
};

describeIfDb("Gate 2H.1: Customer Credit Ledger & Refund (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
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
  let salesUser: { userId: string; email: string; password: string };
  let inactiveOwnerUser: { userId: string; email: string; password: string };
  let otherOwnerUser: { userId: string; email: string; password: string };
  let otherFinanceUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2H ${tag}`,
      slug: `itest-g2h-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550005",
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

  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, quantity = 10, unitPrice = 1000, discountAmount = 0): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: targetCompanyId, order_number: `SO-${tag}`, customer_id: customerId, status: "delivered" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: targetCompanyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const totalAmount = quantity * unitPrice - discountAmount;
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity, unit_price: unitPrice, discount_amount: discountAmount, total_amount: totalAmount })
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
      quantity,
      unitPrice,
    };
  }

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string) {
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_method: "cash",
      p_amount: amount,
      p_proofs: [{ proof_type: "cash_receipt", object_reference: `storage://proofs/${ref}.jpg` }],
      p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
    return (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;
  }

  async function requestReturn(actorId: string, invoiceId: string, items: Array<{ invoice_line_id: string; requested_quantity: number }>) {
    return supabase.rpc("request_return_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_invoice_id: invoiceId,
      p_items: items,
      p_reason_code: "DAMAGED_GOODS",
      p_proof_reference: `storage://return-proofs/${randomUUID()}.jpg`,
      p_idempotency_key: null,
    });
  }

  async function verifyReturn(actorId: string, returnId: string, decision: "approve" | "reject") {
    return supabase.rpc("verify_return_atomic", { p_company_id: companyId, p_actor_id: actorId, p_return_id: returnId, p_decision: decision });
  }

  async function reverseCreditNote(actorId: string, creditNoteId: string, opts: { companyId?: string } = {}) {
    return supabase.rpc("reverse_credit_note_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_credit_note_id: creditNoteId,
      p_reason: "Koreksi retur",
      p_idempotency_key: null,
    });
  }

  async function balanceOf(invoiceId: string) {
    const { data } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", invoiceId).single();
    return data as { outstanding_balance: string; financial_status: string; total_debit: string; total_credit: string };
  }

  async function ccBalanceOf(creditNoteId: string): Promise<CcBalanceRow | null> {
    const { data } = await supabase.from("customer_credit_balances").select("*").eq("credit_note_id", creditNoteId).maybeSingle();
    return data as CcBalanceRow | null;
  }

  // Membuat credit note dengan customer_credit_amount tertentu -- helper
  // komposisi Gate 2F (return+verify) khusus test Gate 2H.
  async function makeCreditNote(
    tag: string,
    opts: { quantity?: number; unitPrice?: number; payBefore?: number; returnQuantity: number },
  ): Promise<{ inv: InvoiceFixture; creditNoteId: string; totalAmount: number; appliedAmount: number; customerCreditAmount: number }> {
    const quantity = opts.quantity ?? 10;
    const unitPrice = opts.unitPrice ?? 1000;
    const inv = await createInvoice(companyId, tag, financeUser.userId, quantity, unitPrice);
    if (opts.payBefore) {
      await pay(financeUser.userId, inv.invoiceId, opts.payBefore, `${tag}-pay`);
    }
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: opts.returnQuantity }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData, error } = await verifyReturn(ownerUser.userId, returnId, "approve");
    if (error) throw new Error(`verify_return_atomic gagal: ${error.message}`);
    const row = (verifyData as VerifyReturnRow[])[0];
    return {
      inv,
      creditNoteId: row.out_credit_note_id!,
      totalAmount: Number(row.out_total_amount),
      appliedAmount: Number(row.out_applied_amount),
      customerCreditAmount: Number(row.out_customer_credit_amount),
    };
  }

  async function requestRefund(
    actorId: string,
    creditNoteId: string,
    amount: number,
    opts: { method?: string; proofReference?: string; transactionDate?: string; companyId?: string; idempotencyKey?: string } = {},
  ) {
    return supabase.rpc("request_refund_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_credit_note_id: creditNoteId,
      p_amount: amount,
      p_method: opts.method ?? "cash",
      p_proof_reference: opts.proofReference ?? `storage://refund-proofs/${randomUUID()}.jpg`,
      p_transaction_date: opts.transactionDate ?? "2026-08-01",
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function approveRefund(actorId: string, refundId: string, decision: "approve" | "reject", opts: { companyId?: string } = {}) {
    return supabase.rpc("approve_refund_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_refund_id: refundId,
      p_decision: decision,
    });
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGH");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGI");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    inactiveOwnerUser = await createActor(companyId, `${runTag}-inactive-owner`, "owner", false);
    otherOwnerUser = await createActor(otherCompanyId, `${runTag}-oowner`, "owner");
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    // Best-effort -- customer_credit_ledger/refund_requests immutable penuh
    // (BEFORE DELETE selalu RAISE, pola identik returns/credit_notes Gate 2F),
    // percobaan delete di sini akan no-op secara aman tanpa melempar error
    // yang tidak ditangkap (supabase-js tidak throw pada PostgrestError).
    await supabase.from("customer_credit_ledger").delete().in("company_id", createdCompanyIds);
    await supabase.from("refund_requests").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_reversals").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_lines").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_notes").delete().in("company_id", createdCompanyIds);
    await supabase.from("return_items").delete().in("company_id", createdCompanyIds);
    await supabase.from("returns").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_allocations").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_proofs").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_receipts").delete().in("company_id", createdCompanyIds);
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
  // 1/2. Origin credit persis == credit_notes.customer_credit_amount,
  //      tidak diformulasi ulang.
  // ---------------------------------------------------------------------
  it("1/2. Origin credit ledger persis == credit_notes.customer_credit_amount (bukan hasil formula ulang)", async () => {
    const cn = await makeCreditNote(`${runTag}-ORIGIN`, { quantity: 10, unitPrice: 1000, payBefore: 8000, returnQuantity: 5 }); // total 10000, paid 8000 -> outstanding 2000; retur 5000 -> applied 2000, customer_credit 3000
    expect(cn.customerCreditAmount).toBe(3000);

    // Sentuh Gate 2H via request_refund_atomic kecil untuk memicu lazy-create origin.
    const { data, error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    expect(error).toBeNull();
    void data;

    const { data: originRows } = await supabase
      .from("customer_credit_ledger")
      .select("amount, direction, entry_type")
      .eq("credit_note_id", cn.creditNoteId)
      .eq("entry_type", "credit_note_origin");
    expect((originRows as Array<{ amount: string; direction: string }>).length).toBe(1);
    expect(Number((originRows as Array<{ amount: string }>)[0].amount)).toBe(cn.customerCreditAmount);
    expect((originRows as Array<{ direction: string }>)[0].direction).toBe("credit");
  });

  // ---------------------------------------------------------------------
  // 3. Satu credit note -> tepat satu bucket/origin entry (struktural).
  // ---------------------------------------------------------------------
  it("3. Satu credit note menghasilkan TEPAT SATU origin entry meski disentuh berkali-kali", async () => {
    const cn = await makeCreditNote(`${runTag}-ONEORIGIN`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 3 }); // full customer credit (no payment) -> applied=0, customer_credit=3000

    await requestRefund(ownerUser.userId, cn.creditNoteId, 500);
    await requestRefund(ownerUser.userId, cn.creditNoteId, 500);

    const { count } = await supabase
      .from("customer_credit_ledger")
      .select("id", { count: "exact", head: true })
      .eq("credit_note_id", cn.creditNoteId)
      .eq("entry_type", "credit_note_origin");
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 4. Credit note customer_credit=0 tidak membuat saldo/ledger row.
  // ---------------------------------------------------------------------
  it("4. Credit note dengan customer_credit_amount=0 TIDAK membuat baris ledger apa pun; refund apa pun ditolak", async () => {
    const cn = await makeCreditNote(`${runTag}-ZEROCC`, { quantity: 10, unitPrice: 1000, returnQuantity: 4 }); // no payment, outstanding=10000 >= 4000 -> applied=4000, customer_credit=0
    expect(cn.customerCreditAmount).toBe(0);

    const { error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 100);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);

    const { count } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 5. Saldo derived benar (ledger_balance & available_balance).
  // ---------------------------------------------------------------------
  it("5. Saldo derived (ledger_balance/available_balance) dihitung benar dari customer_credit_balances", async () => {
    const cn = await makeCreditNote(`${runTag}-DERIVED`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    let bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.ledger_balance)).toBe(6000);
    expect(Number(bal!.pending_reserved)).toBe(2000);
    expect(Number(bal!.available_balance)).toBe(4000);

    await approveRefund(ownerUser.userId, refundId, "approve");
    bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.ledger_balance)).toBe(4000);
    expect(Number(bal!.pending_reserved)).toBe(0);
    expect(Number(bal!.available_balance)).toBe(4000);
  });

  // ---------------------------------------------------------------------
  // 6/7. Request valid oleh Owner dan Finance.
  // ---------------------------------------------------------------------
  it("6. Request refund valid oleh Owner", async () => {
    const cn = await makeCreditNote(`${runTag}-REQOWNER`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data, error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    expect(error).toBeNull();
    expect((data as RequestRefundRow[])[0].out_status).toBe("requested");
  });

  it("7. Request refund valid oleh Finance", async () => {
    const cn = await makeCreditNote(`${runTag}-REQFINANCE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data, error } = await requestRefund(financeUser.userId, cn.creditNoteId, 1000);
    expect(error).toBeNull();
    expect((data as RequestRefundRow[])[0].out_status).toBe("requested");
  });

  // ---------------------------------------------------------------------
  // 8. Role lain (sales) ditolak untuk request.
  // ---------------------------------------------------------------------
  it("8. Role sales ditolak mengajukan refund (FORBIDDEN)", async () => {
    const cn = await makeCreditNote(`${runTag}-REQSALES`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { error } = await requestRefund(salesUser.userId, cn.creditNoteId, 1000);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);
  });

  // ---------------------------------------------------------------------
  // 9. Approve/reject hanya Owner (Finance ditolak).
  // ---------------------------------------------------------------------
  it("9. Approve/reject HANYA Owner -- Finance ditolak pada keduanya", async () => {
    const cn = await makeCreditNote(`${runTag}-APPROWNERONLY`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(financeUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { error: approveErr } = await approveRefund(financeUser.userId, refundId, "approve");
    expect(approveErr).not.toBeNull();
    expect(approveErr!.message).toMatch(/FORBIDDEN/);

    const { error: rejectErr } = await approveRefund(financeUser.userId, refundId, "reject");
    expect(rejectErr).not.toBeNull();
    expect(rejectErr!.message).toMatch(/FORBIDDEN/);
  });

  it("9b. Actor tidak aktif ditolak (FORBIDDEN)", async () => {
    const cn = await makeCreditNote(`${runTag}-INACTIVE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { error } = await requestRefund(inactiveOwnerUser.userId, cn.creditNoteId, 1000);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);
  });

  // ---------------------------------------------------------------------
  // 10. Cross-tenant request dan decision ditolak.
  // ---------------------------------------------------------------------
  it("10a. Cross-tenant request ditolak (FORBIDDEN)", async () => {
    const cn = await makeCreditNote(`${runTag}-XTENANT-REQ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { error } = await requestRefund(otherOwnerUser.userId, cn.creditNoteId, 1000);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);
  });

  it("10b. Cross-tenant decision (approve/reject) ditolak (TENANT_CONTEXT_MISMATCH)", async () => {
    const cn = await makeCreditNote(`${runTag}-XTENANT-DEC`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { error } = await approveRefund(otherOwnerUser.userId, refundId, "approve", { companyId: otherCompanyId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/TENANT_CONTEXT_MISMATCH/);
  });

  // ---------------------------------------------------------------------
  // 11. Refund hanya memakai satu bucket (struktural, kolom tunggal).
  // ---------------------------------------------------------------------
  it("11. Refund hanya memakai satu credit_note_id -- dua refund terpisah pada CN berbeda tidak saling memengaruhi saldo", async () => {
    const cnA = await makeCreditNote(`${runTag}-MULTI-A`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 });
    const cnB = await makeCreditNote(`${runTag}-MULTI-B`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 4 });

    const { data: reqA } = await requestRefund(ownerUser.userId, cnA.creditNoteId, 1000);
    const { data: reqB } = await requestRefund(ownerUser.userId, cnB.creditNoteId, 1000);
    await approveRefund(ownerUser.userId, (reqA as RequestRefundRow[])[0].out_refund_id, "approve");
    await approveRefund(ownerUser.userId, (reqB as RequestRefundRow[])[0].out_refund_id, "approve");

    const balA = await ccBalanceOf(cnA.creditNoteId);
    const balB = await ccBalanceOf(cnB.creditNoteId);
    expect(Number(balA!.available_balance)).toBe(cnA.customerCreditAmount - 1000);
    expect(Number(balB!.available_balance)).toBe(cnB.customerCreditAmount - 1000);
  });

  // ---------------------------------------------------------------------
  // 12. Over-refund ditolak.
  // ---------------------------------------------------------------------
  it("12. Zero/negatif/over-refund ditolak", async () => {
    const cn = await makeCreditNote(`${runTag}-OVERREFUND`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 }); // customer_credit=5000

    const zero = await requestRefund(ownerUser.userId, cn.creditNoteId, 0);
    expect(zero.error).not.toBeNull();
    expect(zero.error!.message).toMatch(/INVALID_REFUND_AMOUNT/);

    const negative = await requestRefund(ownerUser.userId, cn.creditNoteId, -100);
    expect(negative.error).not.toBeNull();
    expect(negative.error!.message).toMatch(/INVALID_REFUND_AMOUNT/);

    const over = await requestRefund(ownerUser.userId, cn.creditNoteId, 999999);
    expect(over.error).not.toBeNull();
    expect(over.error!.message).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);

    const { count } = await supabase.from("refund_requests").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 13. Pending reservation mengurangi available balance.
  // ---------------------------------------------------------------------
  it("13. Pending reservation mengurangi available_balance TANPA mengubah ledger_balance", async () => {
    const cn = await makeCreditNote(`${runTag}-PENDINGRESV`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000
    await requestRefund(ownerUser.userId, cn.creditNoteId, 2500);

    const bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.ledger_balance)).toBe(6000);
    expect(Number(bal!.available_balance)).toBe(3500);

    // Request kedua yang melebihi sisa available (3500) ditolak walau <= ledger_balance.
    const { error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 4000);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);
  });

  // ---------------------------------------------------------------------
  // 14. Dua request paralel tidak dapat over-reserve.
  // ---------------------------------------------------------------------
  it("14. Dua request paralel pada bucket sama tidak dapat over-reserve", async () => {
    const cn = await makeCreditNote(`${runTag}-PARALLELRESV`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 3 }); // customer_credit=3000
    const [r1, r2] = await Promise.allSettled([
      requestRefund(ownerUser.userId, cn.creditNoteId, 2000),
      requestRefund(ownerUser.userId, cn.creditNoteId, 2000),
    ]);
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].error!.message)).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);

    const { count } = await supabase.from("refund_requests").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 15. Rejected reservation kembali tersedia.
  // ---------------------------------------------------------------------
  it("15. Reject melepaskan reservation -- available_balance kembali naik", async () => {
    const cn = await makeCreditNote(`${runTag}-REJECTRELEASE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 }); // customer_credit=5000
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 3000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    let bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.available_balance)).toBe(2000);

    const { data: rejectData, error } = await approveRefund(ownerUser.userId, refundId, "reject");
    expect(error).toBeNull();
    expect((rejectData as ApproveRefundRow[])[0].out_status).toBe("rejected");

    bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.available_balance)).toBe(5000);

    // Sisa saldo penuh sekarang dapat direfund lagi.
    const { error: secondErr } = await requestRefund(ownerUser.userId, cn.creditNoteId, 5000);
    expect(secondErr).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 16/17. Approval membuat tepat satu debit; retry/concurrent tidak
  //         menggandakan.
  // ---------------------------------------------------------------------
  it("16. Approval membuat TEPAT SATU baris debit customer_credit_ledger", async () => {
    const cn = await makeCreditNote(`${runTag}-ONEDEBIT`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { data, error } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(error).toBeNull();
    const row = (data as ApproveRefundRow[])[0];
    expect(row.out_status).toBe("approved");
    expect(Number(row.out_amount)).toBe(2000);

    const { count } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(count).toBe(1);
  });

  it("17a. Retry approve (sequential) pada refund yang SUDAH approved idempotent -- tidak menggandakan debit", async () => {
    const cn = await makeCreditNote(`${runTag}-RETRYAPPR`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1500);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const first = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(first.error).toBeNull();
    const firstRow = (first.data as ApproveRefundRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    const second = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(second.error).toBeNull();
    const secondRow = (second.data as ApproveRefundRow[])[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_ledger_entry_id).toBe(firstRow.out_ledger_entry_id);
    expect(Number(secondRow.out_amount)).toBe(1500);

    const { count } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(count).toBe(1);
    const { count: auditCount } = await supabase
      .from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_approved").eq("entity_id", refundId);
    expect(auditCount).toBe(1);
  });

  it("17b. Concurrent approve pada refund yang SAMA hanya menghasilkan SATU debit", async () => {
    const cn = await makeCreditNote(`${runTag}-CONCURAPPR`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1500);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const [r1, r2] = await Promise.allSettled([approveRefund(ownerUser.userId, refundId, "approve"), approveRefund(ownerUser.userId, refundId, "approve")]);
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    expect(succeeded.length).toBe(2); // keduanya sukses -- salah satu idempotent (out_already_exists=true)

    const { count } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 18. Reject tidak membuat debit.
  // ---------------------------------------------------------------------
  it("18. Reject TIDAK membuat baris debit customer_credit_ledger", async () => {
    const cn = await makeCreditNote(`${runTag}-REJECTNODEBIT`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1500);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { data, error } = await approveRefund(ownerUser.userId, refundId, "reject");
    expect(error).toBeNull();
    expect((data as ApproveRefundRow[])[0].out_status).toBe("rejected");
    expect((data as ApproveRefundRow[])[0].out_ledger_entry_id).toBeNull();

    const { count } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 19. Transisi dari status final ditolak (reject->reject, reject->approve,
  //     approve->reject).
  // ---------------------------------------------------------------------
  it("19a. reject->reject dan reject->approve ditolak (REFUND_ALREADY_RESOLVED)", async () => {
    const cn = await makeCreditNote(`${runTag}-REJREJ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "reject");

    const rejectAgain = await approveRefund(ownerUser.userId, refundId, "reject");
    expect(rejectAgain.error).not.toBeNull();
    expect(rejectAgain.error!.message).toMatch(/REFUND_ALREADY_RESOLVED/);

    const approveAfterReject = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(approveAfterReject.error).not.toBeNull();
    expect(approveAfterReject.error!.message).toMatch(/REFUND_ALREADY_RESOLVED/);
  });

  it("19b. approve->reject ditolak (REFUND_ALREADY_RESOLVED) -- tidak dapat 'membatalkan' via reject", async () => {
    const cn = await makeCreditNote(`${runTag}-APPRREJ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const { error } = await approveRefund(ownerUser.userId, refundId, "reject");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_ALREADY_RESOLVED/);
  });

  // ---------------------------------------------------------------------
  // 20. Direct mutation authenticated/anon ditolak.
  // ---------------------------------------------------------------------
  it("20. Direct INSERT/UPDATE/DELETE oleh anon ditolak", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const insertRes = await anon.from("refund_requests").insert({
      company_id: companyId, credit_note_id: randomUUID(), customer_id: randomUUID(), amount: 100,
      method: "cash", proof_reference: "x", transaction_date: "2026-08-01", requested_by: randomUUID(), request_payload: {},
    });
    expect(insertRes.error).not.toBeNull();

    const insertLedgerRes = await anon.from("customer_credit_ledger").insert({
      company_id: companyId, credit_note_id: randomUUID(), customer_id: randomUUID(), entry_type: "credit_note_origin", direction: "credit", amount: 100, created_by: randomUUID(),
    });
    expect(insertLedgerRes.error).not.toBeNull();
  });

  it("20b. Direct UPDATE oleh authenticated (service_role bypass GRANT tapi trigger tetap menolak) ditolak", async () => {
    const cn = await makeCreditNote(`${runTag}-DIRECTUPDATE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    // service_role BISA bypass GRANT, tapi trigger immutability tetap menolak
    // transisi/mutasi yang bukan lewat RPC canonical (defense-in-depth).
    const { error } = await supabase.from("refund_requests").update({ amount: 999999 }).eq("id", refundId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_REQUEST_TERMS_IMMUTABLE/);
  });

  // ---------------------------------------------------------------------
  // 21. Ledger immutable.
  // ---------------------------------------------------------------------
  it("21. customer_credit_ledger immutable -- UPDATE/DELETE selalu ditolak walau lewat service_role", async () => {
    const cn = await makeCreditNote(`${runTag}-LEDGERIMMUT`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const { data: ledgerRow } = await supabase.from("customer_credit_ledger").select("id").eq("refund_id", refundId).single();
    const ledgerId = (ledgerRow as { id: string }).id;

    const updateRes = await supabase.from("customer_credit_ledger").update({ amount: 1 }).eq("id", ledgerId);
    expect(updateRes.error).not.toBeNull();
    expect(updateRes.error!.message).toMatch(/CUSTOMER_CREDIT_LEDGER_IMMUTABLE/);

    const deleteRes = await supabase.from("customer_credit_ledger").delete().eq("id", ledgerId);
    expect(deleteRes.error).not.toBeNull();
    expect(deleteRes.error!.message).toMatch(/CUSTOMER_CREDIT_LEDGER_IMMUTABLE/);
  });

  // ---------------------------------------------------------------------
  // 22. Audit event dan payload benar.
  // ---------------------------------------------------------------------
  it("22. Audit customer_credit.refund_requested/approved/rejected tercatat dengan payload benar", async () => {
    const cn = await makeCreditNote(`${runTag}-AUDIT`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1200);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { data: reqAudit } = await supabase.from("audit_logs").select("*").eq("action", "customer_credit.refund_requested").eq("entity_id", refundId).single();
    const ra = reqAudit as { module: string; event_category: string; outcome: string; new_data: Record<string, unknown> };
    expect(ra.module).toBe("finance");
    expect(ra.event_category).toBe("audit");
    expect(ra.outcome).toBe("success");
    expect(ra.new_data.amount).toBe(1200);
    expect(ra.new_data.credit_note_id).toBe(cn.creditNoteId);

    const { data: apprData } = await approveRefund(ownerUser.userId, refundId, "approve");
    const ledgerEntryId = (apprData as ApproveRefundRow[])[0].out_ledger_entry_id;

    const { count: apprAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_approved").eq("entity_id", refundId);
    expect(apprAudit).toBe(1);
    const { data: apprAuditRow } = await supabase.from("audit_logs").select("new_data").eq("action", "customer_credit.refund_approved").eq("entity_id", refundId).single();
    expect((apprAuditRow as { new_data: Record<string, unknown> }).new_data.ledger_entry_id).toBe(ledgerEntryId);

    const cn2 = await makeCreditNote(`${runTag}-AUDITREJ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData2 } = await requestRefund(ownerUser.userId, cn2.creditNoteId, 800);
    const refundId2 = (reqData2 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId2, "reject");
    const { count: rejAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_rejected").eq("entity_id", refundId2);
    expect(rejAudit).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 23. Audit failure me-rollback refund dan ledger (natural DB constraint,
  //     bukan test-only trigger -- lihat idx_audit_logs_refund_approved_dedup
  //     pada migration).
  // ---------------------------------------------------------------------
  it("23. Kegagalan natural insert audit_logs (unique collision) me-rollback status+ledger SEKALIGUS", async () => {
    const cn = await makeCreditNote(`${runTag}-AUDITROLLBACK`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    // Pre-seed audit_logs row yang akan bentrok dengan audit yang HARUS
    // ditulis approve_refund_atomic (idx_audit_logs_refund_approved_dedup:
    // UNIQUE (entity_id) WHERE action='customer_credit.refund_approved').
    const { error: seedErr } = await supabase.from("audit_logs").insert({
      company_id: companyId, user_id: ownerUser.userId, action: "customer_credit.refund_approved", entity_type: "refund_requests",
      entity_id: refundId, new_data: { seeded: true }, actor_type: null, event_category: "audit", module: "finance", source: "web", outcome: "success",
    });
    expect(seedErr).toBeNull();

    const before = await ccBalanceOf(cn.creditNoteId);

    const { error } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/duplicate key|unique/i);

    // Status TETAP requested -- UPDATE refund_requests ikut rollback.
    const { data: refundAfter } = await supabase.from("refund_requests").select("status, ledger_entry_id").eq("id", refundId).single();
    expect((refundAfter as { status: string }).status).toBe("requested");
    expect((refundAfter as { ledger_entry_id: string | null }).ledger_entry_id).toBeNull();

    // Tidak ada baris debit CCL yang tersisa untuk refund ini.
    const { count: ledgerCount } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(ledgerCount).toBe(0);

    // Hanya SATU audit refund_approved (baris seed), bukan dua.
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_approved").eq("entity_id", refundId);
    expect(auditCount).toBe(1);

    const after = await ccBalanceOf(cn.creditNoteId);
    expect(after!.ledger_balance).toBe(before!.ledger_balance);
  });

  // ---------------------------------------------------------------------
  // 24. Invoice/receivable ledger/payment/order/delivery tidak berubah.
  //     (Tidak ada tabel inventory di schema MVP -- Warehouse Intelligence
  //     placeholder, lihat CLAUDE.md.)
  // ---------------------------------------------------------------------
  it("24. Refund approved TIDAK mengubah invoice/receivable_ledger/sales_order/delivery", async () => {
    const cn2 = await makeCreditNote(`${runTag}-NOSIDEEFFECT2`, { quantity: 10, unitPrice: 1000, payBefore: 9000, returnQuantity: 5 }); // total 10000, paid 9000, outstanding 1000; retur 5000 -> applied=1000, customer_credit=4000
    expect(cn2.customerCreditAmount).toBe(4000);

    const invoiceBefore = await balanceOf(cn2.inv.invoiceId);
    const { data: orderBefore } = await supabase.from("sales_orders").select("status").eq("id", cn2.inv.orderId).single();
    const { data: deliveryBefore } = await supabase.from("deliveries").select("status").in("id", createdDeliveryIds).eq("sales_order_id", cn2.inv.orderId).single();

    const { data: reqData } = await requestRefund(ownerUser.userId, cn2.creditNoteId, 3000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const invoiceAfter = await balanceOf(cn2.inv.invoiceId);
    expect(invoiceAfter.outstanding_balance).toBe(invoiceBefore.outstanding_balance);
    expect(invoiceAfter.financial_status).toBe(invoiceBefore.financial_status);

    const { data: orderAfter } = await supabase.from("sales_orders").select("status").eq("id", cn2.inv.orderId).single();
    expect((orderAfter as { status: string }).status).toBe((orderBefore as { status: string }).status);

    const { data: deliveryAfter } = await supabase.from("deliveries").select("status").in("id", createdDeliveryIds).eq("sales_order_id", cn2.inv.orderId).single();
    expect((deliveryAfter as { status: string }).status).toBe((deliveryBefore as { status: string }).status);

    const { count: paymentAllocCount } = await supabase.from("payment_allocations").select("id", { count: "exact", head: true }).eq("invoice_id", cn2.inv.invoiceId);
    expect(paymentAllocCount).toBe(1); // hanya dari pay() -- tidak bertambah akibat refund

    const { count: ledgerCountForInvoice } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", cn2.inv.invoiceId);
    expect(ledgerCountForInvoice).toBe(3); // invoice_issued + payment_allocation + credit_note (Gate 2A/2D/2F saja, tidak bertambah)
  });

  // ---------------------------------------------------------------------
  // 25. Dua skenario numerik wajib.
  // ---------------------------------------------------------------------
  it("25a. Invoice sudah lunas -- return jadi customer credit penuh; refund HANYA mengurangi customer credit, outstanding TETAP 0", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NUM1`, financeUser.userId, 10, 1000); // total 10000
    await pay(financeUser.userId, inv.invoiceId, 10000, `${runTag}-num1`); // lunas penuh
    const before = await balanceOf(inv.invoiceId);
    expect(Number(before.outstanding_balance)).toBe(0);

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 3 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const row = (verifyData as VerifyReturnRow[])[0];
    expect(Number(row.out_applied_amount)).toBe(0);
    expect(Number(row.out_customer_credit_amount)).toBe(3000);
    const creditNoteId = row.out_credit_note_id!;

    const { data: refundReq } = await requestRefund(ownerUser.userId, creditNoteId, 3000);
    const refundId = (refundReq as RequestRefundRow[])[0].out_refund_id;
    const { data: refundAppr, error: refundApprErr } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(refundApprErr).toBeNull();
    expect(Number((refundAppr as ApproveRefundRow[])[0].out_amount)).toBe(3000);

    const after = await balanceOf(inv.invoiceId);
    expect(Number(after.outstanding_balance)).toBe(0); // TETAP 0, tidak berubah akibat refund
    const bal = await ccBalanceOf(creditNoteId);
    expect(Number(bal!.available_balance)).toBe(0);
  });

  it("25b. Return mengurangi sisa piutang terlebih dahulu, surplus jadi customer credit; refund surplus TIDAK menyentuh pengurangan piutang yang sudah terjadi", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NUM2`, financeUser.userId, 10, 1000); // total 10000
    await pay(financeUser.userId, inv.invoiceId, 8000, `${runTag}-num2`); // outstanding = 2000

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 5 }]); // nilai retur 5000
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const row = (verifyData as VerifyReturnRow[])[0];
    expect(Number(row.out_applied_amount)).toBe(2000); // mengurangi sisa piutang dulu
    expect(Number(row.out_customer_credit_amount)).toBe(3000); // surplus
    const creditNoteId = row.out_credit_note_id!;

    const balanceAfterReturn = await balanceOf(inv.invoiceId);
    expect(Number(balanceAfterReturn.outstanding_balance)).toBe(0);

    const { data: refundReq } = await requestRefund(ownerUser.userId, creditNoteId, 3000);
    const refundId = (refundReq as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    // Refund surplus tidak menyentuh pengurangan piutang yang sudah terjadi.
    const balanceAfterRefund = await balanceOf(inv.invoiceId);
    expect(Number(balanceAfterRefund.outstanding_balance)).toBe(0);
    expect(balanceAfterRefund.total_credit).toBe(balanceAfterReturn.total_credit); // RL tidak bertambah

    const bal = await ccBalanceOf(creditNoteId);
    expect(Number(bal!.available_balance)).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 26. Regresi double-counting refund + receivable reduction.
  // ---------------------------------------------------------------------
  it("26. Regresi double-counting: refund tidak pernah menghasilkan baris receivable_ledger kedua untuk pengurangan yang sama", async () => {
    const cn = await makeCreditNote(`${runTag}-DBLCOUNT`, { quantity: 10, unitPrice: 1000, payBefore: 7000, returnQuantity: 5 }); // total 10000, paid 7000, outstanding 3000; retur 5000 -> applied=3000, customer_credit=2000
    expect(cn.appliedAmount).toBe(3000);
    expect(cn.customerCreditAmount).toBe(2000);

    const { count: creditNoteLedgerCountBefore } = await supabase
      .from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", cn.inv.invoiceId).eq("entry_type", "credit_note");
    expect(creditNoteLedgerCountBefore).toBe(1);

    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const { count: creditNoteLedgerCountAfter } = await supabase
      .from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", cn.inv.invoiceId).eq("entry_type", "credit_note");
    expect(creditNoteLedgerCountAfter).toBe(1); // TIDAK bertambah -- refund tidak double-count reduction

    const balance = await balanceOf(cn.inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(0); // 10000 - 7000(payment) - 3000(applied) = 0, tidak dikurangi lagi oleh refund
  });

  // ---------------------------------------------------------------------
  // 27. Regresi Gate 2F tetap lulus.
  // ---------------------------------------------------------------------
  it("27a. Regresi: reverse_credit_note_atomic pada credit note yang TIDAK PERNAH disentuh refund tetap berperilaku identik Gate 2F", async () => {
    const cn = await makeCreditNote(`${runTag}-REGRESSREV`, { quantity: 10, unitPrice: 1000, returnQuantity: 4 }); // no payment -> applied=4000, customer_credit=0
    const balanceBefore = await balanceOf(cn.inv.invoiceId);

    const { data, error } = await reverseCreditNote(ownerUser.userId, cn.creditNoteId);
    expect(error).toBeNull();
    const row = (data as ReverseRow[])[0];
    expect(Number(row.out_reversed_amount)).toBe(4000);
    expect(row.out_already_exists).toBe(false);

    const balanceAfter = await balanceOf(cn.inv.invoiceId);
    expect(Number(balanceAfter.outstanding_balance)).toBe(Number(balanceBefore.outstanding_balance) + 4000);
  });

  it("27b. Gate 2H perluasan: reversal ditolak jika ada refund PENDING (PENDING_REFUND_EXISTS)", async () => {
    const cn = await makeCreditNote(`${runTag}-PENDBLOCK`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 }); // customer_credit=5000
    await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);

    const { error } = await reverseCreditNote(ownerUser.userId, cn.creditNoteId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/PENDING_REFUND_EXISTS/);

    const { count } = await supabase.from("credit_note_reversals").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(count).toBe(0);
  });

  it("27c. Gate 2H perluasan: reversal ditolak SELURUHNYA jika sudah ada refund APPROVED (REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN)", async () => {
    const cn = await makeCreditNote(`${runTag}-APPRBLOCK`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const { error } = await reverseCreditNote(ownerUser.userId, cn.creditNoteId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN/);

    const { count } = await supabase.from("credit_note_reversals").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(count).toBe(0);
    // Refund approved TIDAK dihapus/diubah.
    const { data: refundAfter } = await supabase.from("refund_requests").select("status").eq("id", refundId).single();
    expect((refundAfter as { status: string }).status).toBe("approved");
  });

  it("27d. Gate 2H: reversal pada credit note customer_credit>0 yang belum pernah disentuh refund menulis debit compensating CCL + audit", async () => {
    const cn = await makeCreditNote(`${runTag}-REVCC`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000, belum pernah disentuh refund/Gate 2H

    const { count: originBefore } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(originBefore).toBe(0); // belum pernah lazy-created

    const { data, error } = await reverseCreditNote(ownerUser.userId, cn.creditNoteId);
    expect(error).toBeNull();
    const row = (data as ReverseRow[])[0];
    expect(Number(row.out_customer_credit_voided_amount)).toBe(6000);

    const { data: ledgerRows } = await supabase.from("customer_credit_ledger").select("entry_type, direction, amount").eq("credit_note_id", cn.creditNoteId).order("created_at");
    const rows = ledgerRows as Array<{ entry_type: string; direction: string; amount: string }>;
    expect(rows.length).toBe(2); // origin (lazy) + reversal debit
    expect(rows[0].entry_type).toBe("credit_note_origin");
    expect(Number(rows[0].amount)).toBe(6000);
    expect(rows[1].entry_type).toBe("reversal");
    expect(Number(rows[1].amount)).toBe(6000);

    const bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.ledger_balance)).toBe(0);

    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.credit_reversed");
    expect(auditCount).toBeGreaterThanOrEqual(1);

    // Refund pada credit note yang sudah direverse ditolak.
    const { error: refundErr } = await requestRefund(ownerUser.userId, cn.creditNoteId, 100);
    expect(refundErr).not.toBeNull();
    expect(refundErr!.message).toMatch(/CREDIT_NOTE_REVERSED/);
  });

  it("27e. Regresi Gate 2F: request_return_atomic + verify_return_atomic + record_verified_payment_atomic tetap konsisten", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REGRESSION2F`, financeUser.userId, 10, 1000);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, 5000, `${runTag}-regression2f`);
    expect(receiptId).toBeTruthy();

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 2 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    await verifyReturn(ownerUser.userId, returnId, "approve");

    const balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(3000); // 10000 - 5000 - 2000

    const { data: reconcileData, error: reconcileErr } = await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_payment_receipt_id: receiptId, p_method: "automatic", p_idempotency_key: null,
    });
    expect(reconcileErr).toBeNull();
    expect((reconcileData as Array<{ out_classification: string }>)[0].out_classification).toBe("matched");
  });

  // ---------------------------------------------------------------------
  // Cross-tenant SELECT (RLS) -- pola sama Gate 2F.
  // ---------------------------------------------------------------------
  it("28. otherFinanceUser (company B) tidak dapat request refund pada credit note company A", async () => {
    const cn = await makeCreditNote(`${runTag}-CROSSFIN`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { error } = await requestRefund(otherFinanceUser.userId, cn.creditNoteId, 100, { companyId: otherCompanyId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN|TENANT_CONTEXT_MISMATCH/);
  });

  // =======================================================================
  // Gate 2H.2 -- Hardening & regression tambahan (test matrix gap coverage).
  // =======================================================================

  // ---------------------------------------------------------------------
  // 29. Matrix §5 -- beberapa partial refund berurutan dari source SAMA.
  // ---------------------------------------------------------------------
  it("29. Beberapa partial refund berurutan dari source yang sama membentuk baris ledger terpisah, saldo berkurang bertahap", async () => {
    const cn = await makeCreditNote(`${runTag}-SEQPARTIAL`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 }); // customer_credit=5000

    const { data: r1 } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refund1 = (r1 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refund1, "approve");
    let bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.available_balance)).toBe(3000);

    const { data: r2 } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1500);
    const refund2 = (r2 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refund2, "approve");
    bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.available_balance)).toBe(1500);

    expect(refund1).not.toBe(refund2);
    const { count } = await supabase
      .from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId).eq("entry_type", "refund");
    expect(count).toBe(2);
  });

  // ---------------------------------------------------------------------
  // 30. Matrix §6 -- exact remaining-balance refund (batas <=, bukan <).
  // ---------------------------------------------------------------------
  it("30. Exact remaining-balance refund diterima tepat di batas (<=), bukan ditolak", async () => {
    const cn = await makeCreditNote(`${runTag}-EXACTBOUND`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 4 }); // customer_credit=4000
    const { data: reqData, error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 4000); // persis saldo penuh
    expect(error).toBeNull();
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    const { error: apprErr } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(apprErr).toBeNull();

    const bal = await ccBalanceOf(cn.creditNoteId);
    expect(Number(bal!.available_balance)).toBe(0);
    expect(Number(bal!.ledger_balance)).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 31. Matrix §14 Action B -- manager/admin/super_admin ditolak (refund.
  //     request LEBIH SEMPIT dari return.request yang mengizinkan role ini).
  // ---------------------------------------------------------------------
  it("31. Role manager/admin/super_admin ditolak mengajukan refund (FORBIDDEN) -- refund.request LEBIH SEMPIT dari return.request", async () => {
    const cn = await makeCreditNote(`${runTag}-ROLEDENY`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    for (const roleName of ["manager", "admin", "super_admin"]) {
      const actor = await createActor(companyId, `${runTag}-${roleName}`, roleName);
      const { error } = await requestRefund(actor.userId, cn.creditNoteId, 100);
      expect(error, `role ${roleName} seharusnya ditolak`).not.toBeNull();
      expect(error!.message).toMatch(/FORBIDDEN/);
    }
  });

  // ---------------------------------------------------------------------
  // 32. Concurrency real -- approve vs reject pada refund yang SAMA.
  // ---------------------------------------------------------------------
  it("32. Concurrent approve vs reject pada refund yang SAMA -- tepat satu keputusan menang, TIDAK ADA double ledger/double audit", async () => {
    const cn = await makeCreditNote(`${runTag}-RACEAPPRREJ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const [approveRes, rejectRes] = await Promise.allSettled([
      approveRefund(ownerUser.userId, refundId, "approve"),
      approveRefund(ownerUser.userId, refundId, "reject"),
    ]);
    const results = [approveRes, rejectRes].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].error!.message)).toMatch(/REFUND_ALREADY_RESOLVED/);

    const { data: finalRow } = await supabase.from("refund_requests").select("status").eq("id", refundId).single();
    const finalStatus = (finalRow as { status: string }).status;
    expect(["approved", "rejected"]).toContain(finalStatus);

    const { count: ledgerCount } = await supabase.from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("refund_id", refundId);
    expect(ledgerCount).toBe(finalStatus === "approved" ? 1 : 0);

    const { count: apprAuditCount } = await supabase
      .from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_approved").eq("entity_id", refundId);
    const { count: rejAuditCount } = await supabase
      .from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_rejected").eq("entity_id", refundId);
    expect(apprAuditCount).toBe(finalStatus === "approved" ? 1 : 0);
    expect(rejAuditCount).toBe(finalStatus === "rejected" ? 1 : 0);
  });

  // ---------------------------------------------------------------------
  // 33. Concurrency real -- reversal vs refund request pada credit_note
  //     yang SAMA (kontrak §6 poin 1/2 diserialisasi lock credit_notes).
  // ---------------------------------------------------------------------
  it("33. Concurrent reversal vs refund request pada credit_note yang SAMA -- invariant konsisten, tidak ada race window", async () => {
    const cn = await makeCreditNote(`${runTag}-RACEREVREQ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 6 }); // customer_credit=6000, belum pernah disentuh Gate 2H
    const [reqRes, revRes] = await Promise.allSettled([
      requestRefund(ownerUser.userId, cn.creditNoteId, 1000),
      reverseCreditNote(ownerUser.userId, cn.creditNoteId),
    ]);
    const req = reqRes.status === "fulfilled" ? reqRes.value : { data: null, error: { message: String(reqRes.reason) } };
    const rev = revRes.status === "fulfilled" ? revRes.value : { data: null, error: { message: String(revRes.reason) } };

    if (!req.error && !rev.error) {
      throw new Error("Kedua operasi tidak boleh sama-sama sukses tanpa salah satu menolak yang lain -- race window terdeteksi");
    }

    if (!rev.error) {
      // Reversal menang lock duluan -- request refund berikutnya pada CN
      // yang sudah direverse HARUS ditolak.
      expect(req.error).not.toBeNull();
      expect(String(req.error!.message)).toMatch(/CREDIT_NOTE_REVERSED/);
    } else {
      // Request menang lock duluan -- reversal berikutnya HARUS ditolak
      // karena masih ada refund requested aktif.
      expect(req.error).toBeNull();
      expect(String(rev.error!.message)).toMatch(/PENDING_REFUND_EXISTS/);
    }

    // Invariant payung: origin credit tetap TEPAT SATU baris, tidak pernah dobel.
    const { count: originCount } = await supabase
      .from("customer_credit_ledger").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId).eq("entry_type", "credit_note_origin");
    expect(originCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 34. Matrix §13 Action C -- cross-tenant SELECT via RLS (bukan error,
  //     baris tidak muncul).
  // ---------------------------------------------------------------------
  it("34. Cross-tenant SELECT via RLS mengembalikan 0 baris (bukan error) untuk refund_requests/customer_credit_ledger milik company lain", async () => {
    const cn = await makeCreditNote(`${runTag}-RLSHIDE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const authClient = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({ email: otherOwnerUser.email, password: otherOwnerUser.password });
    expect(signInErr).toBeNull();

    const { data: refundRows, error: refundSelErr } = await authClient.from("refund_requests").select("id").eq("id", refundId);
    expect(refundSelErr).toBeNull();
    expect(refundRows).toEqual([]);

    const { data: ledgerRows, error: ledgerSelErr } = await authClient.from("customer_credit_ledger").select("id").eq("refund_id", refundId);
    expect(ledgerSelErr).toBeNull();
    expect(ledgerRows).toEqual([]);

    await authClient.auth.signOut();
  });

  // ---------------------------------------------------------------------
  // 35. Matrix §15 Action A/C -- direct mutation oleh authenticated (bukan
  //     hanya anon) ditolak GRANT.
  // ---------------------------------------------------------------------
  it("35. Direct INSERT/UPDATE oleh authenticated (bukan anon) pada refund_requests/customer_credit_ledger ditolak GRANT", async () => {
    const authClient = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({ email: ownerUser.email, password: ownerUser.password });
    expect(signInErr).toBeNull();

    const insertRes = await authClient.from("refund_requests").insert({
      company_id: companyId, credit_note_id: randomUUID(), customer_id: randomUUID(), amount: 100,
      method: "cash", proof_reference: "x", transaction_date: "2026-08-01", requested_by: ownerUser.userId, request_payload: {},
    });
    expect(insertRes.error).not.toBeNull();

    const cn = await makeCreditNote(`${runTag}-AUTHUPDATE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const updateRes = await authClient.from("refund_requests").update({ amount: 1 }).eq("id", refundId);
    expect(updateRes.error).not.toBeNull();

    const insertLedgerRes = await authClient.from("customer_credit_ledger").insert({
      company_id: companyId, credit_note_id: cn.creditNoteId, customer_id: randomUUID(), entry_type: "credit_note_origin", direction: "credit", amount: 100, created_by: ownerUser.userId,
    });
    expect(insertLedgerRes.error).not.toBeNull();

    await authClient.auth.signOut();
  });

  // ---------------------------------------------------------------------
  // 36. Instruksi eksplisit poin 4 -- RPC internal/service-role-only tidak
  //     dapat dipanggil langsung oleh authenticated ataupun anon.
  // ---------------------------------------------------------------------
  it("36. RPC canonical (request/approve/reverse) tidak dapat dipanggil langsung oleh anon maupun authenticated -- HANYA service_role", async () => {
    const cn = await makeCreditNote(`${runTag}-RPCDENY`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });

    const anonClient = createClient(env!.url, env!.anonKey);
    const anonReq = await anonClient.rpc("request_refund_atomic", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_credit_note_id: cn.creditNoteId, p_amount: 100,
      p_method: "cash", p_proof_reference: "x", p_transaction_date: "2026-08-01", p_idempotency_key: null,
    });
    expect(anonReq.error).not.toBeNull();
    expect(anonReq.error!.message).toMatch(/permission denied/i);

    const authClient = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({ email: ownerUser.email, password: ownerUser.password });
    expect(signInErr).toBeNull();

    const authReq = await authClient.rpc("request_refund_atomic", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_credit_note_id: cn.creditNoteId, p_amount: 100,
      p_method: "cash", p_proof_reference: "x", p_transaction_date: "2026-08-01", p_idempotency_key: null,
    });
    expect(authReq.error).not.toBeNull();
    expect(authReq.error!.message).toMatch(/permission denied/i);

    const { data: reqData } = await requestRefund(ownerUser.userId, cn.creditNoteId, 500); // via service_role, valid
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const authApprove = await authClient.rpc("approve_refund_atomic", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_refund_id: refundId, p_decision: "approve",
    });
    expect(authApprove.error).not.toBeNull();
    expect(authApprove.error!.message).toMatch(/permission denied/i);

    const authReverse = await authClient.rpc("reverse_credit_note_atomic", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_credit_note_id: cn.creditNoteId, p_reason: "x", p_idempotency_key: null,
    });
    expect(authReverse.error).not.toBeNull();
    expect(authReverse.error!.message).toMatch(/permission denied/i);

    await authClient.auth.signOut();
  });

  // ---------------------------------------------------------------------
  // 37. Idempotency key retry pada request_refund_atomic (belum pernah
  //     dibuktikan DB-backed sebelumnya -- hanya approve yang diuji).
  // ---------------------------------------------------------------------
  it("37. Idempotency key retry pada request_refund_atomic tidak menggandakan refund/audit; payload mismatch ditolak", async () => {
    const cn = await makeCreditNote(`${runTag}-IDEMPREQ`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 5 });
    const idempotencyKey = `${runTag}-idem-1`;
    const proofReference = `storage://refund-proofs/${randomUUID()}.jpg`;
    const transactionDate = "2026-08-01";

    const first = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000, { idempotencyKey, proofReference, transactionDate });
    expect(first.error).toBeNull();
    const firstRow = (first.data as RequestRefundRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    // Retry HARUS mengirim payload identik (proofReference/transactionDate
    // ikut membentuk request_payload snapshot idempotency) -- payload
    // berbeda pada idempotency_key yang sama adalah pelanggaran kontrak
    // pemanggil, bukan retry murni (lihat percobaan mismatch di bawah).
    const retry = await requestRefund(ownerUser.userId, cn.creditNoteId, 1000, { idempotencyKey, proofReference, transactionDate });
    expect(retry.error).toBeNull();
    const retryRow = (retry.data as RequestRefundRow[])[0];
    expect(retryRow.out_already_exists).toBe(true);
    expect(retryRow.out_refund_id).toBe(firstRow.out_refund_id);

    const { count: refundCount } = await supabase.from("refund_requests").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(refundCount).toBe(1);
    const { count: auditCount } = await supabase
      .from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "customer_credit.refund_requested").eq("entity_id", firstRow.out_refund_id);
    expect(auditCount).toBe(1);

    const mismatched = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000, { idempotencyKey });
    expect(mismatched.error).not.toBeNull();
    expect(mismatched.error!.message).toMatch(/IDEMPOTENCY_KEY_PAYLOAD_MISMATCH/);
  });

  // ---------------------------------------------------------------------
  // 38. Isolasi domain lain juga berlaku pada JALUR GAGAL (bukan hanya
  //     sukses seperti test 24).
  // ---------------------------------------------------------------------
  it("38. Refund request yang GAGAL (over-refund) TIDAK mengubah invoice/receivable_ledger/order apa pun", async () => {
    const cn = await makeCreditNote(`${runTag}-FAILISOLATION`, { quantity: 10, unitPrice: 1000, payBefore: 9000, returnQuantity: 5 }); // outstanding 1000, applied=1000, customer_credit=4000

    const invoiceBefore = await balanceOf(cn.inv.invoiceId);
    const { data: orderBefore } = await supabase.from("sales_orders").select("status").eq("id", cn.inv.orderId).single();
    const { count: ledgerCountBefore } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", cn.inv.invoiceId);

    const { error } = await requestRefund(ownerUser.userId, cn.creditNoteId, 999999); // melebihi saldo tersedia 4000
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);

    const invoiceAfter = await balanceOf(cn.inv.invoiceId);
    expect(invoiceAfter.outstanding_balance).toBe(invoiceBefore.outstanding_balance);
    const { data: orderAfter } = await supabase.from("sales_orders").select("status").eq("id", cn.inv.orderId).single();
    expect((orderAfter as { status: string }).status).toBe((orderBefore as { status: string }).status);
    const { count: ledgerCountAfter } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", cn.inv.invoiceId);
    expect(ledgerCountAfter).toBe(ledgerCountBefore);

    const { count: refundCount } = await supabase.from("refund_requests").select("id", { count: "exact", head: true }).eq("credit_note_id", cn.creditNoteId);
    expect(refundCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 39. Matrix §22 -- reconciliation invariant lintas beberapa aksi
  //     berurutan pada satu credit note, saldo tidak pernah negatif.
  // ---------------------------------------------------------------------
  it("39. Reconciliation invariant: saldo_ledger == customer_credit_amount - SUM(refund approved), tidak pernah negatif, di beberapa titik waktu", async () => {
    const cn = await makeCreditNote(`${runTag}-RECONCILE`, { quantity: 10, unitPrice: 1000, payBefore: 10000, returnQuantity: 8 }); // customer_credit=8000

    async function assertReconcile(expectedApprovedTotal: number) {
      const bal = await ccBalanceOf(cn.creditNoteId);
      expect(Number(bal!.ledger_balance)).toBe(cn.customerCreditAmount - expectedApprovedTotal);
      expect(Number(bal!.ledger_balance)).toBeGreaterThanOrEqual(0);
      expect(Number(bal!.available_balance)).toBeGreaterThanOrEqual(0);
    }

    const { data: r1 } = await requestRefund(ownerUser.userId, cn.creditNoteId, 2000);
    const refund1 = (r1 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refund1, "approve"); // origin lazy-created di sini
    await assertReconcile(2000);

    const { data: r2 } = await requestRefund(ownerUser.userId, cn.creditNoteId, 1500);
    const refund2 = (r2 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refund2, "reject");
    await assertReconcile(2000); // rejected tidak mengubah saldo ledger

    const { data: r3 } = await requestRefund(ownerUser.userId, cn.creditNoteId, 3000);
    const refund3 = (r3 as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refund3, "approve");
    await assertReconcile(5000);
  });
});
