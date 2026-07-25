// =============================================================================
// DB-backed integration test -- Gate 2I.1 Finance Operations Workspace read
// model (lib/finance/queries.ts).
//
// Membuktikan hal yang tidak bisa dibuktikan unit test murni: tenant
// isolation SUNGGUHAN lewat RLS Postgres (bukan filter di kode aplikasi) dan
// inclusion/exclusion action queue terhadap data nyata (invoice overdue,
// reconciliation exception, return pending). Pola sama dengan
// receivable-ledger-foundation.integration.test.ts -- service_role HANYA
// dipakai di setup/fixture (beforeAll/afterAll), assertion sesungguhnya
// dijalankan lewat client yang sign-in sebagai user finance company A
// (RLS + user_has_permission('receivable.view') aktif penuh). Skip graceful
// bila Supabase lokal tidak tersedia/bukan loopback.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { getFinanceActionQueue } from "./queries";

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
  invoiceId: string;
  invoiceNumber: string;
}

describeIfDb("Gate 2I.1: Finance Action Queue read model (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient; // service_role -- HANYA untuk fixture setup/teardown
  const runTag = `itest-fq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  let financeAuthId = "";
  const financePassword = randomUUID();
  const financeEmail = `${runTag}-finance@itest.test`;

  const createdCompanyIds = [companyId, otherCompanyId];
  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];

  let overdueUnpaidInvoice: InvoiceFixture;
  let overdueButPaidInvoice: InvoiceFixture;
  let otherCompanyInvoice: InvoiceFixture;

  async function createInvoiceFixture(targetCompanyId: string, tag: string, dueDate: string): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await service
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const { data: order, error: orderErr } = await service
      .from("sales_orders")
      .insert({ company_id: targetCompanyId, order_number: `SO-${tag}`, customer_id: customerId, status: "confirmed" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: orderItem, error: itemErr } = await service
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity: 10, unit_price: 1000, total_amount: 10000 })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    const orderItemId = (orderItem as { id: string }).id;

    const { data: delivery, error: delErr } = await service
      .from("deliveries")
      .insert({ company_id: targetCompanyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const { data: deliveryItem, error: diErr } = await service
      .from("delivery_items")
      .insert({ delivery_id: deliveryId, sales_order_item_id: orderItemId, ordered_quantity: 10, dispatched_quantity: 10, received_quantity: 10 })
      .select("id")
      .single();
    if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);
    const deliveryItemId = (deliveryItem as { id: string }).id;

    const businessDate = "2026-08-01";
    const { data: documentNumber, error: numErr } = await service.rpc("allocate_document_number", {
      p_company_id: targetCompanyId,
      p_document_type: "INVOICE",
      p_business_date: businessDate,
    });
    if (numErr) throw new Error(`allocate_document_number gagal: ${numErr.message}`);

    const snapshot = {
      documentType: "INVOICE",
      documentNumber,
      documentDate: businessDate,
      companyId: targetCompanyId,
      orderReference: `SO-${tag}`,
      deliveryReference: `SJ-${tag}`,
      paymentTermsDays: 30,
      lines: [{ no: 1, productCode: null, productName: `Produk ${tag}`, productType: null, unit: "pcs", quantity: 10, unitPrice: 1000, discountAmount: 0, lineTotal: 10000 }],
      totals: { subtotal: 10000, totalDiscount: 0, grandTotal: 10000 },
      generatedAt: new Date().toISOString(),
    };

    const { data: docRows, error: docErr } = await service.rpc("record_issued_document", {
      p_company_id: targetCompanyId,
      p_document_type: "INVOICE",
      p_source_order_id: orderId,
      p_source_delivery_id: deliveryId,
      p_document_number: documentNumber,
      p_snapshot: snapshot,
      p_issued_by: null,
      p_supersedes_document_id: null,
    });
    if (docErr) throw new Error(`record_issued_document gagal: ${docErr.message}`);
    const issuedDocumentId = (docRows as Array<{ out_id: string }>)[0].out_id;

    const { data: invoice, error: invErr } = await service
      .from("invoices")
      .insert({
        company_id: targetCompanyId,
        issued_document_id: issuedDocumentId,
        invoice_number: documentNumber,
        sales_order_id: orderId,
        delivery_id: deliveryId,
        customer_id: customerId,
        issued_at: `${dueDate}T00:00:00.000Z`,
        due_date: dueDate,
        subtotal_amount: 10000,
        discount_amount: 0,
        total_amount: 10000,
      })
      .select("id")
      .single();
    if (invErr) throw new Error(`gagal insert invoice: ${invErr.message}`);
    const invoiceId = (invoice as { id: string }).id;

    const { error: lineErr } = await service.from("invoice_lines").insert({
      invoice_id: invoiceId,
      company_id: targetCompanyId,
      line_no: 1,
      sales_order_item_id: orderItemId,
      delivery_item_id: deliveryItemId,
      product_name: `Produk ${tag}`,
      unit: "pcs",
      quantity: 10,
      unit_price: 1000,
      discount_amount: 0,
      line_total: 10000,
    });
    if (lineErr) throw new Error(`gagal insert invoice_line: ${lineErr.message}`);

    const { error: ledgerErr } = await service.from("receivable_ledger").insert({
      company_id: targetCompanyId,
      invoice_id: invoiceId,
      entry_type: "invoice_issued",
      direction: "debit",
      amount: 10000,
    });
    if (ledgerErr) throw new Error(`gagal insert receivable_ledger opening debit: ${ledgerErr.message}`);

    return { companyId: targetCompanyId, customerId, invoiceId, invoiceNumber: documentNumber as string };
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert([
      { id: companyId, name: `ITest FQ Co ${runTag}`, slug: `itest-fq-${runTag}`, document_number_prefix: "IFQ" },
      { id: otherCompanyId, name: `ITest FQ Co Other ${runTag}`, slug: `itest-fq-other-${runTag}`, document_number_prefix: "IFR" },
    ]);

    const { data: financeAuth, error: financeErr } = await service.auth.admin.createUser({
      email: financeEmail,
      password: financePassword,
      email_confirm: true,
    });
    if (financeErr || !financeAuth.user) throw new Error(`gagal buat auth user finance: ${financeErr?.message}`);
    financeAuthId = financeAuth.user.id;
    await service.from("users").insert({ id: financeAuthId, company_id: companyId, email: financeEmail, full_name: "Finance ITest", is_active: true });

    const { data: financeRole } = await service.from("roles").select("id").is("company_id", null).eq("name", "finance").single();
    await service.from("user_roles").insert({ user_id: financeAuthId, role_id: (financeRole as { id: string }).id, company_id: companyId });

    // --- Invoice overdue: harus tampil (outstanding, due_date lampau) ---
    overdueUnpaidInvoice = await createInvoiceFixture(companyId, `${runTag}-OD`, "2020-01-01");

    // --- Invoice overdue tapi sudah lunas --- harus TIDAK tampil.
    // Dibuat lewat RPC canonical record_verified_payment_atomic (Gate 2D),
    // BUKAN insert manual ke receivable_ledger -- entry_type=payment_allocation
    // dijaga trigger constraint DEFERRED (trg_receivable_ledger_payment_allocation_pairing)
    // yang mewajibkan payment_allocations pasangannya ada dalam TRANSAKSI yang
    // sama; RPC ini menjalankan keduanya atomik dalam satu transaksi server-side.
    overdueButPaidInvoice = await createInvoiceFixture(companyId, `${runTag}-PD`, "2020-01-01");
    const { data: payoffRows, error: payoffErr } = await service.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: financeAuthId,
      p_method: "bank_transfer",
      p_amount: 10000,
      p_proofs: [{ proof_type: "transfer_slip", object_reference: `PROOF-${runTag}-PD` }],
      p_allocations: [{ invoice_id: overdueButPaidInvoice.invoiceId, amount: 10000 }],
    });
    if (payoffErr) throw new Error(`gagal record_verified_payment_atomic (lunas): ${payoffErr.message}`);
    const payoffReceiptId = (payoffRows as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    // Direkonsiliasi juga supaya TIDAK ikut muncul sebagai payment_unverified
    // (skenario ini murni untuk membuktikan exclusion invoice_overdue).
    const { error: payoffReconErr } = await service.rpc("reconcile_verified_payment", {
      p_company_id: companyId,
      p_actor_id: financeAuthId,
      p_payment_receipt_id: payoffReceiptId,
    });
    if (payoffReconErr) throw new Error(`gagal reconcile_verified_payment (lunas): ${payoffReconErr.message}`);

    // --- Invoice company lain -- harus TIDAK pernah tampil untuk company A ---
    otherCompanyInvoice = await createInvoiceFixture(otherCompanyId, `${runTag}-OTH`, "2020-01-01");

    // --- Reconciliation exception: payment_receipt + reconciliation classification=overpaid -- harus tampil ---
    const { data: exceptionReceipt, error: exReceiptErr } = await service
      .from("payment_receipts")
      .insert({
        company_id: companyId,
        customer_id: overdueUnpaidInvoice.customerId,
        method: "bank_transfer",
        amount: 15000,
        recorded_by: financeAuthId,
        request_payload: {},
      })
      .select("id")
      .single();
    if (exReceiptErr) throw new Error(`gagal insert payment_receipt (exception): ${exReceiptErr.message}`);
    const exceptionReceiptId = (exceptionReceipt as { id: string }).id;

    const { error: exReconErr } = await service
      .from("payment_reconciliations")
      .insert({
        company_id: companyId,
        payment_receipt_id: exceptionReceiptId,
        customer_id: overdueUnpaidInvoice.customerId,
        classification: "overpaid",
        payment_amount: 15000,
        total_allocated: 10000,
        unallocated_amount: 5000,
        allocations_snapshot: [],
        method: "manual",
        actor_id: financeAuthId,
      })
      .select("id")
      .single();
    if (exReconErr) throw new Error(`gagal insert payment_reconciliation (exception): ${exReconErr.message}`);

    // --- Reconciliation matched: harus TIDAK tampil sebagai exception ATAU payment_unverified ---
    const { data: matchedReceipt, error: matchedReceiptErr } = await service
      .from("payment_receipts")
      .insert({
        company_id: companyId,
        customer_id: overdueUnpaidInvoice.customerId,
        method: "cash",
        amount: 3000,
        recorded_by: financeAuthId,
        request_payload: {},
      })
      .select("id")
      .single();
    if (matchedReceiptErr) throw new Error(`gagal insert payment_receipt (matched): ${matchedReceiptErr.message}`);
    const matchedReceiptId = (matchedReceipt as { id: string }).id;

    const { error: matchedReconErr } = await service
      .from("payment_reconciliations")
      .insert({
        company_id: companyId,
        payment_receipt_id: matchedReceiptId,
        customer_id: overdueUnpaidInvoice.customerId,
        classification: "matched",
        payment_amount: 3000,
        total_allocated: 3000,
        unallocated_amount: 0,
        allocations_snapshot: [],
        method: "manual",
        actor_id: financeAuthId,
      })
      .select("id")
      .single();
    if (matchedReconErr) throw new Error(`gagal insert payment_reconciliation (matched): ${matchedReconErr.message}`);

    // --- Payment receipt belum direkonsiliasi sama sekali -- harus tampil sebagai payment_unverified ---
    const { error: unverifiedErr } = await service
      .from("payment_receipts")
      .insert({
        company_id: companyId,
        customer_id: overdueUnpaidInvoice.customerId,
        method: "cash",
        amount: 2000,
        recorded_by: financeAuthId,
        request_payload: {},
      })
      .select("id")
      .single();
    if (unverifiedErr) throw new Error(`gagal insert payment_receipt (unverified): ${unverifiedErr.message}`);

    // --- Return requested -- harus tampil ---
    const { error: reqReturnErr } = await service
      .from("returns")
      .insert({
        company_id: companyId,
        customer_id: overdueUnpaidInvoice.customerId,
        invoice_id: overdueUnpaidInvoice.invoiceId,
        sales_order_id: createdOrderIds[0],
        delivery_id: createdDeliveryIds[0],
        status: "requested",
        reason_code: "damaged",
        proof_reference: "PROOF-1",
        requested_by: financeAuthId,
        request_payload: {},
      })
      .select("id")
      .single();
    if (reqReturnErr) throw new Error(`gagal insert return (requested): ${reqReturnErr.message}`);

    // --- Return sudah approved -- harus TIDAK tampil sebagai return_pending ---
    const { error: apprReturnErr } = await service
      .from("returns")
      .insert({
        company_id: companyId,
        customer_id: overdueUnpaidInvoice.customerId,
        invoice_id: overdueUnpaidInvoice.invoiceId,
        sales_order_id: createdOrderIds[0],
        delivery_id: createdDeliveryIds[0],
        status: "approved",
        reason_code: "damaged",
        proof_reference: "PROOF-2",
        requested_by: financeAuthId,
        requested_at: new Date(Date.now() - 60000).toISOString(),
        decided_by: financeAuthId,
        decided_at: new Date().toISOString(),
        request_payload: {},
      })
      .select("id")
      .single();
    if (apprReturnErr) throw new Error(`gagal insert return (approved): ${apprReturnErr.message}`);
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    // Urutan wajib menghormati FK RESTRICT: reconciliations/allocations/proofs
    // (menunjuk payment_receipts & receivable_ledger) dihapus SEBELUM
    // returns/payment_receipts/invoices/receivable_ledger sendiri.
    await service.from("payment_reconciliations").delete().in("company_id", createdCompanyIds);
    await service.from("payment_allocations").delete().in("company_id", createdCompanyIds);
    await service.from("payment_proofs").delete().in("company_id", createdCompanyIds);
    await service.from("returns").delete().in("company_id", createdCompanyIds);
    await service.from("payment_receipts").delete().in("company_id", createdCompanyIds);
    await service.from("receivable_ledger").delete().in("company_id", createdCompanyIds);
    await service.from("invoice_lines").delete().in("company_id", createdCompanyIds);
    await service.from("invoices").delete().in("company_id", createdCompanyIds);
    await service.from("issued_documents").delete().in("company_id", createdCompanyIds);
    await service.from("delivery_items").delete().in("delivery_id", createdDeliveryIds);
    await service.from("deliveries").delete().in("id", createdDeliveryIds);
    await service.from("sales_order_items").delete().in("order_id", createdOrderIds);
    await service.from("sales_orders").delete().in("id", createdOrderIds);
    await service.from("customers").delete().in("id", createdCustomerIds);
    await service.from("document_number_counters").delete().in("company_id", createdCompanyIds);
    if (financeAuthId) {
      await service.from("user_roles").delete().eq("user_id", financeAuthId);
      await service.from("users").delete().eq("id", financeAuthId);
      await service.auth.admin.deleteUser(financeAuthId);
    }
    await service.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  async function signInAsFinance(): Promise<SupabaseClient> {
    const client = createServiceClient(env!.url, env!.anonKey);
    const { error } = await client.auth.signInWithPassword({ email: financeEmail, password: financePassword });
    if (error) throw new Error(`gagal sign-in finance ITest: ${error.message}`);
    return client;
  }

  it("1. Tenant isolation: finance company A tidak pernah melihat invoice/return company lain", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const referenceNumbers = result.items.map((i) => i.referenceNumber);
    expect(referenceNumbers).not.toContain(otherCompanyInvoice.invoiceNumber);
    expect(result.failedCategories).toEqual([]);
  });

  it("2. Invoice overdue outstanding tampil dengan outstanding_balance canonical (bukan dihitung ulang)", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const item = result.items.find(
      (i) => i.category === "invoice_overdue" && i.referenceNumber === overdueUnpaidInvoice.invoiceNumber
    );
    expect(item).toBeDefined();
    expect(item?.amount).toBe(10000);
    expect(item?.statusCode).toBe("outstanding");
  });

  it("3. Invoice overdue yang sudah lunas (credit ledger penuh) TIDAK tampil di antrean", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const item = result.items.find(
      (i) => i.category === "invoice_overdue" && i.referenceNumber === overdueButPaidInvoice.invoiceNumber
    );
    expect(item).toBeUndefined();
  });

  it("4. Reconciliation exception (overpaid) tampil; matched TIDAK tampil sebagai exception maupun payment_unverified", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const exceptionItems = result.items.filter((i) => i.category === "reconciliation_exception");
    expect(exceptionItems.length).toBe(1);
    expect(exceptionItems[0].statusCode).toBe("overpaid");
    expect(exceptionItems[0].amount).toBe(5000);

    const unverifiedItems = result.items.filter((i) => i.category === "payment_unverified");
    // Hanya receipt yang BENAR-BENAR belum direkonsiliasi yang boleh tampil --
    // receipt matched dan receipt exception (overpaid, sudah punya baris
    // reconciliation) TIDAK termasuk payment_unverified.
    expect(unverifiedItems.length).toBe(1);
  });

  it("5. Return requested tampil, return approved TIDAK tampil sebagai return_pending", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const returnItems = result.items.filter((i) => i.category === "return_pending");
    expect(returnItems.length).toBe(1);
    expect(returnItems[0].statusCode).toBe("requested");
  });

  it("6. Ordering deterministik: invoice_overdue (priority 1) selalu sebelum return_pending (priority 5)", async () => {
    const scoped = await signInAsFinance();
    const result = await getFinanceActionQueue(companyId, scoped);

    const invoiceIdx = result.items.findIndex((i) => i.category === "invoice_overdue");
    const returnIdx = result.items.findIndex((i) => i.category === "return_pending");
    expect(invoiceIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(invoiceIdx);
  });
});
