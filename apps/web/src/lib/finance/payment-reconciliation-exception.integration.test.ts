// =============================================================================
// DB-backed integration test -- Gate 2E: Payment Reconciliation & Exception
// Handling (supabase/migrations/20260830000001_payment_reconciliation_exception.sql).
//
// Membuktikan: reconcile_verified_payment()/correct_payment_reconciliation()
// -- klasifikasi HANYA mengukur payment reconciliation (total_allocated vs
// payment_amount), BUKAN invoice settlement -- cicilan sah yang fully
// allocated tetap matched walau invoice masih outstanding, dan karenanya
// TIDAK muncul di exception projection. Allocation snapshot deterministic
// dari fakta DB (bukan payload), tenant/actor/idempotency/concurrency safety,
// append-only history, correction re-derive dengan definisi yang SAMA, dan
// invariant Gate 2D (partially_matched/unmatched/overpaid level PAYMENT
// mustahil via RPC produksi) TIDAK dilemahkan. Skip graceful jika kredensial
// Supabase lokal tidak tersedia atau URL bukan loopback -- pola sama dengan
// payment-receipt-proof-allocation.integration.test.ts (Gate 2D).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260830000001_payment_reconciliation_exception.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB).
// ---------------------------------------------------------------------------
describe("Gate 2E -- static proof atomicity & vocabulary (migration 20260830000001)", () => {
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

  it("reconcile_verified_payment() adalah SATU function body tanpa blok EXCEPTION (audit failure selalu rollback)", () => {
    const body = extractFunctionBody("reconcile_verified_payment");
    expect(body).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("correct_payment_reconciliation() adalah SATU function body tanpa blok EXCEPTION (audit failure selalu rollback)", () => {
    const body = extractFunctionBody("correct_payment_reconciliation");
    expect(body).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("kedua RPC terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sig1 = "public.reconcile_verified_payment(UUID, UUID, UUID, TEXT, TEXT)";
    const sig2 = "public.correct_payment_reconciliation(UUID, UUID, UUID, TEXT, TEXT)";
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig1}\n  FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig1}\n  TO service_role;`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig2}\n  FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig2}\n  TO service_role;`);
  });

  it("izin payment.reconcile HANYA digrant ke owner/finance (bukan manager/admin/super_admin)", () => {
    expect(migration).toContain("AND r.name IN ('owner', 'finance')\n  AND p.name = 'payment.reconcile'");
  });

  it("domain classification mendeklarasikan vocabulary penuh termasuk 'shortpaid' (forward-compatible, tidak diemit kode)", () => {
    expect(migration).toContain("CHECK (classification IN ('matched', 'partially_matched', 'unmatched', 'overpaid', 'shortpaid'))");
  });

  it("kedua RPC TIDAK menerima parameter allocations -- allocation selalu diderivasi dari payment_allocations", () => {
    const body1 = extractFunctionBody("reconcile_verified_payment");
    const body2 = extractFunctionBody("correct_payment_reconciliation");
    expect(body1).not.toMatch(/p_allocations/);
    expect(body2).not.toMatch(/p_allocations/);
    expect(body1).toContain("FROM public.payment_allocations pa");
    expect(body2).toContain("FROM public.payment_allocations pa");
  });

  it("payment_reconciliations immutable penuh -- tidak ada jalur UPDATE yang mengizinkan transisi (full block, beda dari promises_to_pay)", () => {
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON public.payment_reconciliations");
    expect(migration).toContain("RECONCILIATION_APPEND_ONLY");
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
}

type AllocationSummary = { invoiceId: string; allocatedAmount: string; financialStatus: string };
type ReconcileRow = {
  out_reconciliation_id: string;
  out_classification: string;
  out_total_allocated: string;
  out_unallocated_amount: string;
  out_allocations: AllocationSummary[];
  out_already_exists: boolean;
};
type CorrectRow = ReconcileRow & { out_previous_reconciliation_id: string };

describeIfDb("Gate 2E: Payment Reconciliation & Exception Handling (DB-backed, Postgres nyata)", () => {
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
  let inactiveFinanceUser: { userId: string; email: string; password: string };
  let otherFinanceUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2E ${tag}`,
      slug: `itest-g2e-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550004",
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

  // Invoice fixture nyata lewat issue_invoice_atomic (Gate 2B).
  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, quantity = 10, unitPrice = 1000): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const orderId = await createOrderInvoice(targetCompanyId, tag, actorId, customerId, quantity, unitPrice);
    return orderId;
  }

  async function createOrderInvoice(
    targetCompanyId: string,
    tag: string,
    actorId: string,
    customerId: string,
    quantity: number,
    unitPrice: number,
  ): Promise<InvoiceFixture> {
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

    return { companyId: targetCompanyId, customerId, orderId, invoiceId: row.out_invoice_id, totalAmount: Number(row.out_total_amount) };
  }

  function oneProof(ref: string) {
    return [{ proof_type: "bank_transfer_receipt", object_reference: `storage://proofs/${ref}.jpg`, metadata: { size: 1024 } }];
  }

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string, transferReference?: string) {
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_method: transferReference ? "bank_transfer" : "cash",
      p_amount: amount,
      p_proofs: oneProof(ref),
      p_allocations: [{ invoice_id: invoiceId, amount }],
      ...(transferReference ? { p_transfer_reference: transferReference } : {}),
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
    return (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;
  }

  async function reconcile(actorId: string, paymentReceiptId: string, opts: { method?: string; idempotencyKey?: string; companyId?: string } = {}) {
    return supabase.rpc("reconcile_verified_payment", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_payment_receipt_id: paymentReceiptId,
      p_method: opts.method ?? "automatic",
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function correct(actorId: string, reconciliationId: string, reason: string, opts: { idempotencyKey?: string; companyId?: string } = {}) {
    return supabase.rpc("correct_payment_reconciliation", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_reconciliation_id: reconciliationId,
      p_reason: reason,
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function balanceOf(invoiceId: string) {
    const { data } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", invoiceId).single();
    return data as { outstanding_balance: string; financial_status: string; total_debit: string; total_credit: string };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGE");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGF");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    inactiveFinanceUser = await createActor(companyId, `${runTag}-inactive`, "finance", false);
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("payment_reconciliations").delete().in("company_id", createdCompanyIds);
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
  // 1. Exact match -> matched, satu reconciliation + satu audit
  // ---------------------------------------------------------------------

  it("1. Pembayaran lunas (full) menghasilkan classification=matched, satu reconciliation dan satu audit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-MATCH`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-match`);

    const { data, error } = await reconcile(financeUser.userId, receiptId);
    expect(error).toBeNull();
    const row = (data as ReconcileRow[])[0];
    expect(row.out_classification).toBe("matched");
    expect(Number(row.out_total_allocated)).toBe(inv.totalAmount);
    expect(Number(row.out_unallocated_amount)).toBe(0);
    expect(row.out_already_exists).toBe(false);

    const { count: reconCount } = await supabase.from("payment_reconciliations").select("id", { count: "exact", head: true }).eq("payment_receipt_id", receiptId);
    expect(reconCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", row.out_reconciliation_id).eq("action", "reconciliation.matched");
    expect(auditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 2. Split payment ke beberapa invoice -> allocations unik, terurut
  //    deterministic, satu reconciliation event untuk keseluruhan set.
  // ---------------------------------------------------------------------

  it("2. Split payment ke dua invoice customer sama menghasilkan SATU reconciliation dengan allocations terurut invoice_id ASC", async () => {
    const invA = await createInvoice(companyId, `${runTag}-SPLIT-A`, financeUser.userId, 10, 1000); // 10000
    const invB = await createOrderInvoice(companyId, `${runTag}-SPLIT-B`, financeUser.userId, invA.customerId, 5, 1000); // 5000
    const [first, second] = [invA.invoiceId, invB.invoiceId].sort();

    const { data: payData, error: payErr } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: 15000,
      p_proofs: oneProof(`${runTag}-split`),
      p_allocations: [
        { invoice_id: invA.invoiceId, amount: 10000 },
        { invoice_id: invB.invoiceId, amount: 5000 },
      ],
      p_transfer_reference: `TRF-${runTag}-SPLIT`,
    });
    expect(payErr).toBeNull();
    const receiptId = (payData as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const { data, error } = await reconcile(financeUser.userId, receiptId);
    expect(error).toBeNull();
    const row = (data as ReconcileRow[])[0];
    expect(row.out_classification).toBe("matched");
    expect(row.out_allocations.length).toBe(2);
    expect(row.out_allocations[0].invoiceId).toBe(first);
    expect(row.out_allocations[1].invoiceId).toBe(second);

    const { count: reconCount } = await supabase.from("payment_reconciliations").select("id", { count: "exact", head: true }).eq("payment_receipt_id", receiptId);
    expect(reconCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 3/4. Cicilan sah (payment fully allocated, invoice masih outstanding)
  //      -> payment reconciliation TETAP matched. Invoice settlement (lunas/
  //      outstanding/partially_paid) adalah state TERPISAH -- tidak boleh
  //      bocor ke classification payment. TIDAK PERNAH shortpaid.
  // ---------------------------------------------------------------------

  it("1b/3/4. Payment Rp3 juta yang SELURUHNYA dialokasikan ke invoice Rp10 juta menghasilkan matched, walau invoice masih outstanding (cicilan sah)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INSTALL`, financeUser.userId, 10, 1_000_000); // invoice 10 juta
    const receiptId = await pay(financeUser.userId, inv.invoiceId, 3_000_000, `${runTag}-install`);

    const { data, error } = await reconcile(financeUser.userId, receiptId);
    expect(error).toBeNull();
    const row = (data as ReconcileRow[])[0];

    // Payment reconciliation: seluruh payment (3 juta) sudah habis dialokasikan -> matched.
    expect(row.out_classification).toBe("matched");
    expect(row.out_classification).not.toBe("partially_matched");
    expect(row.out_classification).not.toBe("shortpaid");
    expect(Number(row.out_total_allocated)).toBe(3_000_000);
    expect(Number(row.out_unallocated_amount)).toBe(0);

    // Invoice settlement: TETAP outstanding sesuai ledger/status existing (Gate 2A) --
    // classification payment TIDAK PERNAH memaksa/mengubah state ini.
    expect(row.out_allocations[0].financialStatus).toBe("partially_paid");
    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("partially_paid");
    expect(Number(balance.outstanding_balance)).toBe(7_000_000);

    // Cicilan sah yang fully allocated TIDAK BOLEH muncul di exception projection.
    const { data: exception } = await supabase.from("payment_reconciliation_exceptions").select("id").eq("payment_receipt_id", receiptId).maybeSingle();
    expect(exception).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 5. Exception projection -- HANYA exception rekonsiliasi NYATA yang masuk.
  //    Cicilan sah (fully allocated, invoice masih outstanding) BUKAN
  //    exception rekonsiliasi -- TIDAK BOLEH muncul. unmatched (defensif,
  //    lihat test #14) adalah exception NYATA -- HARUS muncul.
  // ---------------------------------------------------------------------

  it("5. payment_reconciliation_exceptions HANYA memuat exception nyata (unmatched), BUKAN cicilan sah yang fully allocated (matched)", async () => {
    const invInstall = await createInvoice(companyId, `${runTag}-EXC-INSTALL`, financeUser.userId, 10, 1000);
    const receiptInstall = await pay(financeUser.userId, invInstall.invoiceId, 3000, `${runTag}-exc-install`);
    const { data: installData } = await reconcile(financeUser.userId, receiptInstall);
    const installRow = (installData as ReconcileRow[])[0];
    expect(installRow.out_classification).toBe("matched"); // cicilan sah, payment fully allocated

    const customer = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}-EXC-UNMATCHED`, code: `CUST-${runTag}-EXC-UNMATCHED` })
      .select("id")
      .single();
    const customerId = (customer.data as { id: string }).id;
    createdCustomerIds.push(customerId);
    // Direct service_role insert, BUKAN lewat RPC -- lihat catatan test #14
    // untuk alasan ini bukan backdoor (tidak ada trigger/kolom test-only).
    const { data: unmatchedReceipt } = await supabase
      .from("payment_receipts")
      .insert({ company_id: companyId, customer_id: customerId, method: "cash", amount: 2000, recorded_by: financeUser.userId, request_payload: {} })
      .select("id")
      .single();
    const receiptUnmatched = (unmatchedReceipt as { id: string }).id;
    const { data: unmatchedData } = await reconcile(financeUser.userId, receiptUnmatched);
    const unmatchedRow = (unmatchedData as ReconcileRow[])[0];
    expect(unmatchedRow.out_classification).toBe("unmatched"); // exception nyata

    const { data: exceptions, error } = await supabase
      .from("payment_reconciliation_exceptions")
      .select("id, classification, payment_receipt_id")
      .in("payment_receipt_id", [receiptInstall, receiptUnmatched]);
    expect(error).toBeNull();
    const ids = (exceptions ?? []).map((e) => (e as { id: string }).id);
    expect(ids).toContain(unmatchedRow.out_reconciliation_id);
    expect(ids).not.toContain(installRow.out_reconciliation_id);
  });

  // ---------------------------------------------------------------------
  // 5b/5c. partially_matched dan overpaid (level PAYMENT, bukan invoice)
  // dibuktikan sebagai invariant Gate 2D -- BUKAN difabrikasi. Satu-satunya
  // jalur produksi yang membuat payment_receipts+payment_allocations sekaligus
  // adalah record_verified_payment_atomic(), dan ALLOCATION_TOTAL_MISMATCH
  // (Gate 2D) menolak SEBELUM insert apa pun jika SUM(allocations) != amount
  // PERSIS -- baik kurang (partially_matched) maupun lebih (overpaid).
  // ---------------------------------------------------------------------

  it("5b. partially_matched (level payment) mustahil via record_verified_payment_atomic -- allocation KURANG dari amount ditolak ALLOCATION_TOTAL_MISMATCH", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INV-PARTIALPAY`, financeUser.userId, 10, 1000); // 10000
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 5000,
      p_proofs: oneProof(`${runTag}-inv-partialpay`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 3000 }], // kurang dari 5000
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ALLOCATION_TOTAL_MISMATCH");
    // Tidak ada payment_receipts yang tersisa -- state partially_matched (level
    // payment) tidak pernah tercipta lewat jalur produksi ini.
    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("customer_id", inv.customerId);
    expect(count).toBe(0);
  });

  it("5c. overpaid (level payment) mustahil via record_verified_payment_atomic -- allocation LEBIH dari amount ditolak ALLOCATION_TOTAL_MISMATCH", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INV-OVERPAY`, financeUser.userId, 10, 1000); // 10000
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 5000,
      p_proofs: oneProof(`${runTag}-inv-overpay`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 8000 }], // lebih dari 5000
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ALLOCATION_TOTAL_MISMATCH");
    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("customer_id", inv.customerId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 6. Cross-tenant ditolak
  // ---------------------------------------------------------------------

  it("6. Reconcile dengan p_company_id yang bukan pemilik payment_receipt ditolak (TENANT_CONTEXT_MISMATCH)", async () => {
    const inv = await createInvoice(otherCompanyId, `${runTag}-XT`, otherFinanceUser.userId);
    const receiptId = await payAs(otherCompanyId, otherFinanceUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-xt`);

    const { error } = await reconcile(financeUser.userId, receiptId, { companyId });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TENANT_CONTEXT_MISMATCH");
  });

  async function payAs(targetCompanyId: string, actorId: string, invoiceId: string, amount: number, ref: string) {
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: targetCompanyId, p_actor_id: actorId, p_method: "cash", p_amount: amount,
      p_proofs: oneProof(ref), p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
    return (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;
  }

  // ---------------------------------------------------------------------
  // 7. Actor illegal/inactive/cross-tenant ditolak; owner diizinkan
  // ---------------------------------------------------------------------

  it("7a. Actor role sales (tanpa permission payment.reconcile) ditolak FORBIDDEN", async () => {
    const inv = await createInvoice(companyId, `${runTag}-SALESFORBID`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-salesforbid`);
    const { error } = await reconcile(salesUser.userId, receiptId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("7b. Actor nonaktif ditolak FORBIDDEN", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INACTIVE`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-inactive`);
    const { error } = await reconcile(inactiveFinanceUser.userId, receiptId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("7c. Actor tenant lain ditolak FORBIDDEN", async () => {
    const inv = await createInvoice(companyId, `${runTag}-XACTOR`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-xactor`);
    const { error } = await reconcile(otherFinanceUser.userId, receiptId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("7d. Actor role owner diizinkan (permission payment.reconcile mencakup owner)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OWNEROK`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-ownerok`);
    const { error } = await reconcile(ownerUser.userId, receiptId);
    expect(error).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 8. Payment tidak ada/tidak verified ditolak
  // ---------------------------------------------------------------------

  it("8. payment_receipt_id yang tidak ada (tidak pernah verified) ditolak PAYMENT_RECEIPT_NOT_FOUND", async () => {
    const { error } = await reconcile(financeUser.userId, randomUUID());
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PAYMENT_RECEIPT_NOT_FOUND");
  });

  // ---------------------------------------------------------------------
  // 9. Retry idempotent tidak menggandakan
  // ---------------------------------------------------------------------

  it("9a. Retry idempotent (idempotency_key sama) tidak menggandakan reconciliation/audit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IDEM`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-idem`);
    const key = `idem-${runTag}-recon`;

    const first = await reconcile(financeUser.userId, receiptId, { idempotencyKey: key });
    expect(first.error).toBeNull();
    const firstRow = (first.data as ReconcileRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    const second = await reconcile(financeUser.userId, receiptId, { idempotencyKey: key });
    expect(second.error).toBeNull();
    const secondRow = (second.data as ReconcileRow[])[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_reconciliation_id).toBe(firstRow.out_reconciliation_id);

    const { count: reconCount } = await supabase.from("payment_reconciliations").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("idempotency_key", key);
    expect(reconCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", firstRow.out_reconciliation_id);
    expect(auditCount).toBe(1);
  });

  it("9b. idempotency_key yang sama dipakai untuk payment_receipt berbeda ditolak (IDEMPOTENCY_KEY_PAYMENT_MISMATCH)", async () => {
    const invA = await createInvoice(companyId, `${runTag}-IDEMDIFF-A`, financeUser.userId);
    const invB = await createInvoice(companyId, `${runTag}-IDEMDIFF-B`, financeUser.userId);
    const receiptA = await pay(financeUser.userId, invA.invoiceId, invA.totalAmount, `${runTag}-idemdiff-a`);
    const receiptB = await pay(financeUser.userId, invB.invoiceId, invB.totalAmount, `${runTag}-idemdiff-b`);
    const key = `idem-${runTag}-diffpayment`;

    const first = await reconcile(financeUser.userId, receiptA, { idempotencyKey: key });
    expect(first.error).toBeNull();

    const second = await reconcile(financeUser.userId, receiptB, { idempotencyKey: key });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain("IDEMPOTENCY_KEY_PAYMENT_MISMATCH");
  });

  // ---------------------------------------------------------------------
  // 10. Concurrent identical request tidak menghasilkan event ganda
  // ---------------------------------------------------------------------

  it("10. Dua panggilan concurrent reconcile_verified_payment (idempotency_key sama) hanya menghasilkan SATU reconciliation", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CONCUR`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-concur`);
    const key = `idem-${runTag}-concur`;

    const [r1, r2] = await Promise.allSettled([
      reconcile(financeUser.userId, receiptId, { idempotencyKey: key }),
      reconcile(financeUser.userId, receiptId, { idempotencyKey: key }),
    ]);

    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean) as Array<{ data: unknown; error: unknown }>;
    for (const r of results) {
      expect(r.error).toBeNull();
    }

    const { count: reconCount } = await supabase.from("payment_reconciliations").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("idempotency_key", key);
    expect(reconCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "reconciliation.matched").eq("company_id", companyId).contains("new_data", { payment_id: receiptId });
    expect(auditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 11. Reconciliation history immutable
  // ---------------------------------------------------------------------

  it("11. payment_reconciliations immutable -- UPDATE dan DELETE ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IMMUT`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-immut`);
    const { data } = await reconcile(financeUser.userId, receiptId);
    const reconciliationId = (data as ReconcileRow[])[0].out_reconciliation_id;

    const update = await supabase.from("payment_reconciliations").update({ classification: "unmatched" }).eq("id", reconciliationId);
    expect(update.error).not.toBeNull();
    expect(update.error!.message).toContain("RECONCILIATION_APPEND_ONLY");

    const del = await supabase.from("payment_reconciliations").delete().eq("id", reconciliationId);
    expect(del.error).not.toBeNull();
    expect(del.error!.message).toContain("RECONCILIATION_APPEND_ONLY");
  });

  // ---------------------------------------------------------------------
  // 12. Correction membuat event baru tanpa mengubah history lama
  // ---------------------------------------------------------------------

  it("12a. Correction wajib menyertakan reason (REASON_REQUIRED)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOREASON`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, 3000, `${runTag}-noreason`);
    const { data } = await reconcile(financeUser.userId, receiptId);
    const reconciliationId = (data as ReconcileRow[])[0].out_reconciliation_id;

    const { error } = await correct(financeUser.userId, reconciliationId, "");
    expect(error).not.toBeNull();
    expect(error!.message).toContain("REASON_REQUIRED");
  });

  it("12b. Correction menulis baris BARU (previous_reconciliation_id) tanpa mengubah baris lama; classification TETAP matched -- stabil terhadap perubahan invoice settlement setelahnya (definisi SAMA dengan reconcile_verified_payment)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CORRECT`, financeUser.userId, 10, 1000); // 10000
    const receiptFirst = await pay(financeUser.userId, inv.invoiceId, 4000, `${runTag}-correct1`);
    const { data: firstData } = await reconcile(financeUser.userId, receiptFirst);
    const firstRow = (firstData as ReconcileRow[])[0];
    expect(firstRow.out_classification).toBe("matched"); // payment 4000 sudah habis dialokasikan

    const beforeOld = await supabase.from("payment_reconciliations").select("*").eq("id", firstRow.out_reconciliation_id).single();

    // Payment KEDUA (receipt berbeda) melunasi sisa invoice -- invoice sekarang
    // 'paid'. Ini TIDAK BOLEH mengubah classification reconciliation payment
    // PERTAMA -- payment reconciliation dan invoice settlement adalah state
    // terpisah (kontrak hardening).
    await pay(financeUser.userId, inv.invoiceId, 6000, `${runTag}-correct2`);
    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("paid");

    // Correction terhadap reconciliation PERTAMA re-derive dengan definisi
    // SAMA PERSIS dengan reconcile_verified_payment -- total_allocated payment
    // pertama tetap 4000 (allocations immutable, tidak pernah bertambah), jadi
    // classification TETAP matched, TIDAK ikut berubah mengikuti status
    // invoice yang sekarang sudah paid.
    const { data: correctData, error: correctErr } = await correct(financeUser.userId, firstRow.out_reconciliation_id, "Re-check rutin setelah pelunasan sisa invoice oleh payment lain");
    expect(correctErr).toBeNull();
    const correctRow = (correctData as CorrectRow[])[0];
    expect(correctRow.out_previous_reconciliation_id).toBe(firstRow.out_reconciliation_id);
    expect(correctRow.out_classification).toBe("matched");
    expect(Number(correctRow.out_total_allocated)).toBe(4000); // allocation payment pertama TIDAK berubah

    const afterOld = await supabase.from("payment_reconciliations").select("*").eq("id", firstRow.out_reconciliation_id).single();
    expect(afterOld.data).toEqual(beforeOld.data); // baris lama TIDAK berubah sama sekali

    // classification SAMA (matched) dengan sebelumnya -- tapi karena SUDAH
    // matched (bukan exception), audit action tetap reconciliation.corrected,
    // BUKAN unmatched_again (unmatched_again khusus exception yang persisten,
    // lihat 12c).
    const { data: auditRow } = await supabase.from("audit_logs").select("action").eq("entity_id", correctRow.out_reconciliation_id).single();
    expect((auditRow as { action: string }).action).toBe("reconciliation.corrected");
  });

  it("12c. Correction berulang terhadap exception NYATA (unmatched) yang belum berubah menghasilkan audit reconciliation.unmatched_again", async () => {
    const customer = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}-REPEAT`, code: `CUST-${runTag}-REPEAT` })
      .select("id")
      .single();
    const customerId = (customer.data as { id: string }).id;
    createdCustomerIds.push(customerId);
    // Direct service_role insert (bare receipt, tanpa allocation) -- lihat
    // catatan test #14 untuk alasan ini bukan backdoor.
    const { data: receipt } = await supabase
      .from("payment_receipts")
      .insert({ company_id: companyId, customer_id: customerId, method: "cash", amount: 4000, recorded_by: financeUser.userId, request_payload: {} })
      .select("id")
      .single();
    const receiptId = (receipt as { id: string }).id;

    const { data: firstData } = await reconcile(financeUser.userId, receiptId);
    const firstRow = (firstData as ReconcileRow[])[0];
    expect(firstRow.out_classification).toBe("unmatched"); // exception nyata

    // Correction -- fakta belum berubah (masih tidak ada allocation sama sekali).
    const { data: correctData, error: correctErr } = await correct(financeUser.userId, firstRow.out_reconciliation_id, "Re-check rutin, belum ada allocation baru");
    expect(correctErr).toBeNull();
    const correctRow = (correctData as CorrectRow[])[0];
    expect(correctRow.out_classification).toBe("unmatched"); // sama dengan sebelumnya, exception masih persisten

    const { data: auditRow } = await supabase
      .from("audit_logs")
      .select("action")
      .eq("entity_id", correctRow.out_reconciliation_id)
      .single();
    expect((auditRow as { action: string }).action).toBe("reconciliation.unmatched_again");
  });

  it("12d. Correction terhadap reconciliation milik company lain ditolak TENANT_CONTEXT_MISMATCH", async () => {
    const inv = await createInvoice(otherCompanyId, `${runTag}-XTCORRECT`, otherFinanceUser.userId);
    const receiptId = await payAs(otherCompanyId, otherFinanceUser.userId, inv.invoiceId, 3000, `${runTag}-xtcorrect`);
    const { data } = await reconcile(otherFinanceUser.userId, receiptId, { companyId: otherCompanyId });
    const reconciliationId = (data as ReconcileRow[])[0].out_reconciliation_id;

    const { error } = await correct(financeUser.userId, reconciliationId, "Percobaan koreksi lintas tenant", { companyId });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TENANT_CONTEXT_MISMATCH");
  });

  // ---------------------------------------------------------------------
  // 13. Rekonsiliasi tidak menulis ulang payment/allocation/invoice/ledger/order
  // ---------------------------------------------------------------------

  it("13. Reconcile TIDAK mengubah payment_receipts/payment_allocations/invoices/receivable_ledger/sales_orders.status", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOSIDEEFFECT`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-nosideeffect`);

    const beforeReceipt = await supabase.from("payment_receipts").select("*").eq("id", receiptId).single();
    const beforeAlloc = await supabase.from("payment_allocations").select("*").eq("payment_receipt_id", receiptId);
    const beforeInvoice = await supabase.from("invoices").select("*").eq("id", inv.invoiceId).single();
    const beforeLedger = await supabase.from("receivable_ledger").select("*").eq("invoice_id", inv.invoiceId);
    const beforeOrder = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();

    const { data: reconData, error: reconErr } = await reconcile(financeUser.userId, receiptId);
    expect(reconErr).toBeNull();
    const reconciliationId = (reconData as ReconcileRow[])[0].out_reconciliation_id;
    const { error: correctErr } = await correct(financeUser.userId, reconciliationId, "Verifikasi tidak ada side effect");
    expect(correctErr).toBeNull();

    const afterReceipt = await supabase.from("payment_receipts").select("*").eq("id", receiptId).single();
    const afterAlloc = await supabase.from("payment_allocations").select("*").eq("payment_receipt_id", receiptId);
    const afterInvoice = await supabase.from("invoices").select("*").eq("id", inv.invoiceId).single();
    const afterLedger = await supabase.from("receivable_ledger").select("*").eq("invoice_id", inv.invoiceId);
    const afterOrder = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();

    expect(afterReceipt.data).toEqual(beforeReceipt.data);
    expect(afterAlloc.data).toEqual(beforeAlloc.data);
    expect(afterInvoice.data).toEqual(beforeInvoice.data);
    expect(afterLedger.data).toEqual(beforeLedger.data);
    expect(afterOrder.data).toEqual(beforeOrder.data);
  });

  // ---------------------------------------------------------------------
  // 14. Unmatched (defensif) -- payment tanpa allocation sama sekali
  // ---------------------------------------------------------------------

  it("14. Payment tanpa allocation sama sekali (mustahil via record_verified_payment_atomic, ALLOCATION_REQUIRED) tetap diklasifikasikan unmatched jika ada (defense-in-depth) dan masuk exception projection", async () => {
    const customer = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}-NOALLOC`, code: `CUST-${runTag}-NOALLOC` })
      .select("id")
      .single();
    const customerId = (customer.data as { id: string }).id;
    createdCustomerIds.push(customerId);

    // Direct service_role insert -- BUKAN lewat record_verified_payment_atomic
    // (RPC produksi TIDAK PERNAH bisa membuat state ini, ALLOCATION_REQUIRED
    // mewajibkan >=1 allocation dibuat SEKALIGUS dalam transaksi yang sama).
    // Ini membuktikan reconcile_verified_payment defensif -- tidak
    // mengasumsikan invariant RPC lain selalu benar -- BUKAN backdoor di
    // migration produksi (tidak ada trigger/kolom test-only ditambahkan).
    const { data: receipt, error: receiptErr } = await supabase
      .from("payment_receipts")
      .insert({
        company_id: companyId, customer_id: customerId, method: "cash", amount: 5000,
        recorded_by: financeUser.userId, request_payload: {},
      })
      .select("id")
      .single();
    expect(receiptErr).toBeNull();
    const receiptId = (receipt as { id: string }).id;

    const { data, error } = await reconcile(financeUser.userId, receiptId);
    expect(error).toBeNull();
    const row = (data as ReconcileRow[])[0];
    expect(row.out_classification).toBe("unmatched");
    expect(Number(row.out_total_allocated)).toBe(0);
    expect(Number(row.out_unallocated_amount)).toBe(5000);

    const { data: exception } = await supabase.from("payment_reconciliation_exceptions").select("classification").eq("payment_receipt_id", receiptId).single();
    expect((exception as { classification: string }).classification).toBe("unmatched");
  });

  // ---------------------------------------------------------------------
  // 15. Direct mutation / anon ditolak
  // ---------------------------------------------------------------------

  it("15a. Direct client mutation (anon) pada payment_reconciliations ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ANON`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-anon`);
    const anon = createClient(env!.url, env!.anonKey);

    const insert = await anon.from("payment_reconciliations").insert({
      company_id: companyId, payment_receipt_id: receiptId, customer_id: inv.customerId, classification: "matched",
      payment_amount: inv.totalAmount, total_allocated: inv.totalAmount, unallocated_amount: 0, allocations_snapshot: [],
      method: "automatic", actor_id: financeUser.userId,
    });
    expect(insert.error).not.toBeNull();
  });

  it("15b. Security posture: anon TIDAK dapat memanggil RPC Gate 2E sama sekali", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ANONRPC`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-anonrpc`);
    const anon = createClient(env!.url, env!.anonKey);
    const { error } = await anon.rpc("reconcile_verified_payment", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_payment_receipt_id: receiptId,
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 16. Canonical audit payload
  // ---------------------------------------------------------------------

  it("16. Canonical audit memiliki payload deterministic (payment_id, allocations, classification, method)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-AUDIT`, financeUser.userId);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-audit`);
    const { data } = await reconcile(financeUser.userId, receiptId, { method: "manual" });
    const reconciliationId = (data as ReconcileRow[])[0].out_reconciliation_id;

    const { data: audit } = await supabase.from("audit_logs").select("*").eq("entity_id", reconciliationId).eq("action", "reconciliation.matched").single();
    const a = audit as { company_id: string; module: string; event_category: string; outcome: string; new_data: Record<string, unknown> };
    expect(a.company_id).toBe(companyId);
    expect(a.module).toBe("finance");
    expect(a.event_category).toBe("audit");
    expect(a.outcome).toBe("success");
    expect(a.new_data.payment_id).toBe(receiptId);
    expect(a.new_data.method).toBe("manual");
    expect(a.new_data.classification).toBe("matched");
  });

  // ---------------------------------------------------------------------
  // 17. Tenant isolation SELECT -- dua sesi nyata
  // ---------------------------------------------------------------------

  it("17. Tenant isolation SELECT: finance company A melihat reconciliation sendiri, TIDAK melihat company B", async () => {
    const invA = await createInvoice(companyId, `${runTag}-TENA`, financeUser.userId);
    const receiptA = await pay(financeUser.userId, invA.invoiceId, invA.totalAmount, `${runTag}-tena`);
    const { data: reconA } = await reconcile(financeUser.userId, receiptA);
    const reconAId = (reconA as ReconcileRow[])[0].out_reconciliation_id;

    const invB = await createInvoice(otherCompanyId, `${runTag}-TENB`, otherFinanceUser.userId);
    const receiptB = await payAs(otherCompanyId, otherFinanceUser.userId, invB.invoiceId, invB.totalAmount, `${runTag}-tenb`);
    const { data: reconB } = await reconcile(otherFinanceUser.userId, receiptB, { companyId: otherCompanyId });
    const reconBId = (reconB as ReconcileRow[])[0].out_reconciliation_id;

    const client = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: financeUser.email, password: financeUser.password });
    expect(signInErr).toBeNull();

    const own = await client.from("payment_reconciliations").select("id").eq("id", reconAId);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);

    const cross = await client.from("payment_reconciliations").select("id").eq("id", reconBId);
    expect(cross.error).toBeNull();
    expect((cross.data ?? []).length).toBe(0);

    await client.auth.signOut();
  });
});
