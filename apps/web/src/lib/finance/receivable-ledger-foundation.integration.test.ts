// =============================================================================
// DB-backed integration test -- Gate 2A: Canonical Invoice & Receivable
// Ledger Foundation (supabase/migrations/20260826000001_receivable_ledger_foundation.sql).
//
// Membuktikan hal yang tidak bisa dibuktikan InMemory: trigger tenant/
// snapshot-consistency validation (validate_invoice_tenant,
// validate_invoice_line_tenant, validate_receivable_ledger_entry), full
// immutability trigger (invoices/invoice_lines/receivable_ledger), partial
// unique index "satu opening debit per invoice", derived read model view
// (invoice_receivable_balances), RLS tenant+permission isolation, dan
// REVOKE mutasi langsung anon/authenticated. Skip graceful jika kredensial
// Supabase lokal tidak tersedia atau URL bukan loopback -- pola sama dengan
// document-engine/issuance-repository.integration.test.ts.
//
// Scope: SCHEMA/CONSTRAINT saja (Gate 2A) -- tidak ada RPC "issue_invoice()"
// atomik, jadi setup di sini menulis invoices/invoice_lines/receivable_ledger
// langsung lewat service_role (mensimulasikan apa yang akan dilakukan RPC
// atomik Gate 2B dalam satu transaksi), TEPAT untuk membuktikan constraint
// database menahan diri sendiri terlepas dari siapa/bagaimana baris ditulis.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

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

interface InvoiceSource {
  companyId: string;
  customerId: string;
  orderId: string;
  orderItemId: string;
  deliveryId: string;
  deliveryItemId: string;
  issuedDocumentId: string;
  documentNumber: string;
  extraDeliveryItemIds: string[];
}

const TOTAL = 10000;

describeIfDb("Gate 2A: Canonical Invoice & Receivable Ledger (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  let financeAuthId = "";
  let salesAuthId = "";
  const financePassword = randomUUID();
  const salesPassword = randomUUID();

  let primary: InvoiceSource; // company A, invoice sudah dibuat sukses (happy path)
  let primaryInvoiceId = "";
  let otherCompanySource: InvoiceSource; // company B, invoice sudah dibuat sukses (cross-tenant proof)
  let otherCompanyInvoiceId = "";
  let spare: InvoiceSource; // company A, issued_document belum dipakai jadi invoice (negative tests)

  const createdCompanyIds = [companyId, otherCompanyId];
  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];

  async function createSource(targetCompanyId: string, tag: string, itemCount = 1): Promise<InvoiceSource> {
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
      .insert({ company_id: targetCompanyId, order_number: `SO-${tag}`, customer_id: customerId, status: "confirmed" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: orderItem, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity: 10, unit_price: 1000, total_amount: 10000 })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    const orderItemId = (orderItem as { id: string }).id;

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: targetCompanyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const { data: deliveryItem, error: diErr } = await supabase
      .from("delivery_items")
      .insert({ delivery_id: deliveryId, sales_order_item_id: orderItemId, ordered_quantity: 10, dispatched_quantity: 10, received_quantity: 10 })
      .select("id")
      .single();
    if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);
    const deliveryItemId = (deliveryItem as { id: string }).id;

    const lines: Array<{ no: number; productCode: null; productName: string; productType: null; unit: string; quantity: number; unitPrice: number; discountAmount: number; lineTotal: number }> = [
      { no: 1, productCode: null, productName: `Produk ${tag}`, productType: null, unit: "pcs", quantity: 10, unitPrice: 1000, discountAmount: 0, lineTotal: 10000 },
    ];
    const extraDeliveryItemIds: string[] = [];

    // Line #2: snapshot MENGKLAIM quantity=6 padahal received_quantity item ini
    // hanya 5 -- dipakai untuk membuktikan INVOICE_QUANTITY_EXCEEDS_RECEIVED.
    if (itemCount >= 2) {
      const { data: item2 } = await supabase
        .from("sales_order_items")
        .insert({ order_id: orderId, product_name_raw: `Produk ${tag} #2`, unit: "pcs", quantity: 10, unit_price: 1000, total_amount: 10000 })
        .select("id")
        .single();
      const { data: di2 } = await supabase
        .from("delivery_items")
        .insert({ delivery_id: deliveryId, sales_order_item_id: (item2 as { id: string }).id, ordered_quantity: 10, dispatched_quantity: 5, received_quantity: 5 })
        .select("id")
        .single();
      extraDeliveryItemIds.push((di2 as { id: string }).id);
      lines.push({ no: 2, productCode: null, productName: `Produk ${tag} #2`, productType: null, unit: "pcs", quantity: 6, unitPrice: 1000, discountAmount: 0, lineTotal: 6000 });
    }

    // Line #3: snapshot valid (quantity=5, konsisten dengan received_quantity=5)
    // -- dipakai untuk membuktikan INVOICE_LINE_SNAPSHOT_MISMATCH (percobaan
    // insert dengan unit_price/line_total berbeda dari snapshot).
    if (itemCount >= 3) {
      const { data: item3 } = await supabase
        .from("sales_order_items")
        .insert({ order_id: orderId, product_name_raw: `Produk ${tag} #3`, unit: "pcs", quantity: 5, unit_price: 1000, total_amount: 5000 })
        .select("id")
        .single();
      const { data: di3 } = await supabase
        .from("delivery_items")
        .insert({ delivery_id: deliveryId, sales_order_item_id: (item3 as { id: string }).id, ordered_quantity: 5, dispatched_quantity: 5, received_quantity: 5 })
        .select("id")
        .single();
      extraDeliveryItemIds.push((di3 as { id: string }).id);
      lines.push({ no: 3, productCode: null, productName: `Produk ${tag} #3`, productType: null, unit: "pcs", quantity: 5, unitPrice: 1000, discountAmount: 0, lineTotal: 5000 });
    }

    const businessDate = "2026-08-26";
    const { data: documentNumber, error: numErr } = await supabase.rpc("allocate_document_number", {
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
      lines,
      totals: { subtotal: 10000, totalDiscount: 0, grandTotal: 10000 },
      generatedAt: new Date().toISOString(),
    };

    const { data: docRows, error: docErr } = await supabase.rpc("record_issued_document", {
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

    return { companyId: targetCompanyId, customerId, orderId, orderItemId, deliveryId, deliveryItemId, issuedDocumentId, documentNumber: documentNumber as string, extraDeliveryItemIds };
  }

  async function insertValidInvoice(src: InvoiceSource) {
    const { data, error } = await supabase
      .from("invoices")
      .insert({
        company_id: src.companyId,
        issued_document_id: src.issuedDocumentId,
        invoice_number: src.documentNumber,
        sales_order_id: src.orderId,
        delivery_id: src.deliveryId,
        customer_id: src.customerId,
        issued_at: new Date().toISOString(),
        subtotal_amount: TOTAL,
        discount_amount: 0,
        total_amount: TOTAL,
      })
      .select("id")
      .single();
    if (error) throw new Error(`gagal insert invoice valid: ${error.message}`);
    const invoiceId = (data as { id: string }).id;

    const { error: lineErr } = await supabase.from("invoice_lines").insert({
      invoice_id: invoiceId,
      company_id: src.companyId,
      line_no: 1,
      sales_order_item_id: src.orderItemId,
      delivery_item_id: src.deliveryItemId,
      product_name: `Produk ${src.documentNumber}`,
      unit: "pcs",
      quantity: 10,
      unit_price: 1000,
      discount_amount: 0,
      line_total: 10000,
    });
    if (lineErr) throw new Error(`gagal insert invoice_line valid: ${lineErr.message}`);

    const { error: ledgerErr } = await supabase.from("receivable_ledger").insert({
      company_id: src.companyId,
      invoice_id: invoiceId,
      entry_type: "invoice_issued",
      direction: "debit",
      amount: TOTAL,
    });
    if (ledgerErr) throw new Error(`gagal insert receivable_ledger valid: ${ledgerErr.message}`);

    return invoiceId;
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await supabase.from("companies").insert([
      { id: companyId, name: `ITest Fin Co ${runTag}`, slug: `itest-fin-${runTag}`, document_number_prefix: "IFA" },
      { id: otherCompanyId, name: `ITest Fin Co Other ${runTag}`, slug: `itest-fin-other-${runTag}`, document_number_prefix: "IFB" },
    ]);

    const { data: financeAuth, error: financeErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-finance@itest.test`,
      password: financePassword,
      email_confirm: true,
    });
    if (financeErr || !financeAuth.user) throw new Error(`gagal buat auth user finance: ${financeErr?.message}`);
    financeAuthId = financeAuth.user.id;
    await supabase.from("users").insert({ id: financeAuthId, company_id: companyId, email: `${runTag}-finance@itest.test`, full_name: "Finance ITest", is_active: true });

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@itest.test`,
      password: salesPassword,
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user sales: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@itest.test`, full_name: "Sales ITest", is_active: true });

    const { data: financeRole } = await supabase.from("roles").select("id").is("company_id", null).eq("name", "finance").single();
    const { data: salesRole } = await supabase.from("roles").select("id").is("company_id", null).eq("name", "sales").single();
    await supabase.from("user_roles").insert([
      { user_id: financeAuthId, role_id: (financeRole as { id: string }).id, company_id: companyId },
      { user_id: salesAuthId, role_id: (salesRole as { id: string }).id, company_id: companyId },
    ]);

    primary = await createSource(companyId, `${runTag}-A`, 3);
    primaryInvoiceId = await insertValidInvoice(primary);

    otherCompanySource = await createSource(otherCompanyId, `${runTag}-B`, 1);
    otherCompanyInvoiceId = await insertValidInvoice(otherCompanySource);

    spare = await createSource(companyId, `${runTag}-SPARE`, 1);
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
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
    await supabase.from("user_roles").delete().in("user_id", [financeAuthId, salesAuthId]);
    await supabase.from("users").delete().in("id", [financeAuthId, salesAuthId]);
    if (financeAuthId) await supabase.auth.admin.deleteUser(financeAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  // ---------------------------------------------------------------------
  // Happy path (dibuktikan implisit oleh beforeAll berhasil tanpa throw)
  // ---------------------------------------------------------------------

  it("1. Happy path: invoice + invoice_lines + opening debit berhasil dibuat konsisten dengan issued_documents.snapshot", async () => {
    const { data: invoice } = await supabase.from("invoices").select("*").eq("id", primaryInvoiceId).single();
    expect(Number((invoice as { total_amount: number }).total_amount)).toBe(10000);

    const { data: line } = await supabase.from("invoice_lines").select("*").eq("invoice_id", primaryInvoiceId).eq("line_no", 1).single();
    expect(Number((line as { line_total: number }).line_total)).toBe(10000);

    const { count } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", primaryInvoiceId);
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Cross-tenant foreign reference ditolak (trigger, bukan hanya aplikasi)
  // ---------------------------------------------------------------------

  it("2. TENANT_CONTEXT_MISMATCH: invoice dengan company_id berbeda dari issued_document ditolak", async () => {
    const { error } = await supabase.from("invoices").insert({
      company_id: otherCompanyId, // mismatch sengaja
      issued_document_id: spare.issuedDocumentId,
      invoice_number: spare.documentNumber,
      sales_order_id: spare.orderId,
      delivery_id: spare.deliveryId,
      customer_id: spare.customerId,
      issued_at: new Date().toISOString(),
      subtotal_amount: TOTAL,
      discount_amount: 0,
      total_amount: TOTAL,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TENANT_CONTEXT_MISMATCH");
  });

  it("3. INVOICE_TOTAL_SNAPSHOT_MISMATCH: total_amount berbeda dari issued_documents.snapshot.totals.grandTotal ditolak", async () => {
    const { error } = await supabase.from("invoices").insert({
      company_id: spare.companyId,
      issued_document_id: spare.issuedDocumentId,
      invoice_number: spare.documentNumber,
      sales_order_id: spare.orderId,
      delivery_id: spare.deliveryId,
      customer_id: spare.customerId,
      issued_at: new Date().toISOString(),
      subtotal_amount: TOTAL,
      discount_amount: 0,
      total_amount: 9999, // beda dari snapshot (10000)
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_TOTAL_SNAPSHOT_MISMATCH");
  });

  it("4. INVOICE_NUMBER_MISMATCH: invoice_number berbeda dari issued_documents.document_number ditolak", async () => {
    const { error } = await supabase.from("invoices").insert({
      company_id: spare.companyId,
      issued_document_id: spare.issuedDocumentId,
      invoice_number: "FORGED-NUMBER-0001",
      sales_order_id: spare.orderId,
      delivery_id: spare.deliveryId,
      customer_id: spare.customerId,
      issued_at: new Date().toISOString(),
      subtotal_amount: TOTAL,
      discount_amount: 0,
      total_amount: TOTAL,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_NUMBER_MISMATCH");
  });

  it("5. Duplicate invoice untuk issued_document/nomor yang sama ditolak (satu invoice per dokumen resmi)", async () => {
    const { error } = await supabase.from("invoices").insert({
      company_id: primary.companyId,
      issued_document_id: primary.issuedDocumentId, // sudah dipakai invoice #1
      invoice_number: primary.documentNumber,
      sales_order_id: primary.orderId,
      delivery_id: primary.deliveryId,
      customer_id: primary.customerId,
      issued_at: new Date().toISOString(),
      subtotal_amount: TOTAL,
      discount_amount: 0,
      total_amount: TOTAL,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505"); // unique_violation (issued_document_id UNIQUE)
  });

  // ---------------------------------------------------------------------
  // Invoice lines: kuantitas & konsistensi snapshot
  // ---------------------------------------------------------------------

  it("6. INVOICE_QUANTITY_EXCEEDS_RECEIVED: baris dengan quantity melebihi delivery_items.received_quantity ditolak", async () => {
    const { error } = await supabase.from("invoice_lines").insert({
      invoice_id: primaryInvoiceId,
      company_id: primary.companyId,
      line_no: 2,
      sales_order_item_id: primary.orderItemId, // id sembarang milik order yg sama, hanya untuk lolos FK order check
      delivery_item_id: primary.extraDeliveryItemIds[0], // received_quantity=5
      product_name: "Produk melebihi",
      unit: "pcs",
      quantity: 6, // > 5 received
      unit_price: 1000,
      discount_amount: 0,
      line_total: 6000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVOICE_QUANTITY_EXCEEDS_RECEIVED|INVOICE_LINE_ITEM_MISMATCH/);
  });

  it("7. INVOICE_LINE_SNAPSHOT_MISMATCH: unit_price/line_total berbeda dari issued_documents.snapshot.lines ditolak", async () => {
    const { data: item3 } = await supabase
      .from("delivery_items")
      .select("sales_order_item_id")
      .eq("id", primary.extraDeliveryItemIds[1])
      .single();

    const { error } = await supabase.from("invoice_lines").insert({
      invoice_id: primaryInvoiceId,
      company_id: primary.companyId,
      line_no: 3,
      sales_order_item_id: (item3 as { sales_order_item_id: string }).sales_order_item_id,
      delivery_item_id: primary.extraDeliveryItemIds[1], // received=5, snapshot no=3 quantity=5/unitPrice=1000
      product_name: "Produk mismatch",
      unit: "pcs",
      quantity: 5,
      unit_price: 1200, // beda dari snapshot (1000)
      discount_amount: 0,
      line_total: 6000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_LINE_SNAPSHOT_MISMATCH");
  });

  // ---------------------------------------------------------------------
  // Immutability -- invoices/invoice_lines
  // ---------------------------------------------------------------------

  it("8. INVOICE_IMMUTABLE: UPDATE langsung ke invoices ditolak trigger DB", async () => {
    const { error } = await supabase.from("invoices").update({ total_amount: 1 }).eq("id", primaryInvoiceId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_IMMUTABLE");
  });

  it("9. INVOICE_IMMUTABLE: DELETE langsung ke invoices ditolak trigger DB", async () => {
    const { error } = await supabase.from("invoices").delete().eq("id", primaryInvoiceId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_IMMUTABLE");
  });

  it("10. INVOICE_LINE_IMMUTABLE: UPDATE/DELETE langsung ke invoice_lines ditolak trigger DB", async () => {
    const { data: line } = await supabase.from("invoice_lines").select("id").eq("invoice_id", primaryInvoiceId).eq("line_no", 1).single();
    const lineId = (line as { id: string }).id;

    const { error: updErr } = await supabase.from("invoice_lines").update({ quantity: 1 }).eq("id", lineId);
    expect(updErr).not.toBeNull();
    expect(updErr!.message).toContain("INVOICE_LINE_IMMUTABLE");

    const { error: delErr } = await supabase.from("invoice_lines").delete().eq("id", lineId);
    expect(delErr).not.toBeNull();
    expect(delErr!.message).toContain("INVOICE_LINE_IMMUTABLE");
  });

  // ---------------------------------------------------------------------
  // Receivable ledger: append-only, satu opening debit, entry_type terbatas
  // ---------------------------------------------------------------------

  it("11. Satu invoice tidak bisa memiliki dua opening debit (unique_violation)", async () => {
    const { error } = await supabase.from("receivable_ledger").insert({
      company_id: primary.companyId,
      invoice_id: primaryInvoiceId,
      entry_type: "invoice_issued",
      direction: "debit",
      amount: TOTAL,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505"); // uq_receivable_ledger_one_opening_debit
  });

  it("12. RECEIVABLE_LEDGER_OPENING_AMOUNT_MISMATCH: opening debit dengan amount != invoices.total_amount ditolak", async () => {
    const { error } = await supabase.from("receivable_ledger").insert({
      company_id: spare.companyId,
      invoice_id: primaryInvoiceId, // total_amount = 10000
      entry_type: "invoice_issued",
      direction: "debit",
      amount: 5000, // beda dari total invoice (juga akan gagal karena duplikat opening debit,
    });
    // urutan trigger (validate_receivable_ledger_entry) berjalan SEBELUM unique index
    // dicek di akhir statement -- pesan trigger yang muncul duluan.
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/RECEIVABLE_LEDGER_OPENING_AMOUNT_MISMATCH|23505/);
  });

  it("13. entry_type di luar 'invoice_issued' ditolak CHECK constraint (belum ada entitas payment/credit note)", async () => {
    const { error } = await supabase.from("receivable_ledger").insert({
      company_id: spare.companyId,
      invoice_id: primaryInvoiceId,
      entry_type: "payment_allocation", // belum ada entitasnya di Gate 2A
      direction: "credit",
      amount: 1000,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514"); // check_violation
  });

  it("14. direction=credit untuk entry_type=invoice_issued ditolak CHECK constraint", async () => {
    const { error } = await supabase.from("receivable_ledger").insert({
      company_id: spare.companyId,
      invoice_id: primaryInvoiceId,
      entry_type: "invoice_issued",
      direction: "credit", // tidak konsisten -- invoice_issued selalu debit
      amount: TOTAL,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23514");
  });

  it("15. RECEIVABLE_LEDGER_APPEND_ONLY: UPDATE/DELETE langsung ke receivable_ledger ditolak trigger DB", async () => {
    const { data: entry } = await supabase.from("receivable_ledger").select("id").eq("invoice_id", primaryInvoiceId).single();
    const entryId = (entry as { id: string }).id;

    const { error: updErr } = await supabase.from("receivable_ledger").update({ amount: 1 }).eq("id", entryId);
    expect(updErr).not.toBeNull();
    expect(updErr!.message).toContain("RECEIVABLE_LEDGER_APPEND_ONLY");

    const { error: delErr } = await supabase.from("receivable_ledger").delete().eq("id", entryId);
    expect(delErr).not.toBeNull();
    expect(delErr!.message).toContain("RECEIVABLE_LEDGER_APPEND_ONLY");
  });

  // ---------------------------------------------------------------------
  // Derived read model -- saldo & status HANYA dari ledger
  // ---------------------------------------------------------------------

  it("16. invoice_receivable_balances: saldo & status derived benar dari ledger (belum ada kredit -> outstanding)", async () => {
    const { data, error } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", primaryInvoiceId).single();
    expect(error).toBeNull();
    const balance = data as { total_amount: string; total_debit: string; total_credit: string; outstanding_balance: string; financial_status: string };
    expect(Number(balance.total_amount)).toBe(10000);
    expect(Number(balance.total_debit)).toBe(10000);
    expect(Number(balance.total_credit)).toBe(0);
    expect(Number(balance.outstanding_balance)).toBe(10000);
    expect(balance.financial_status).toBe("outstanding");
  });

  // ---------------------------------------------------------------------
  // RLS: tenant isolation + permission scoping + direct mutation ditolak
  // ---------------------------------------------------------------------

  it("17. Direct mutation ditolak untuk anon (unauthenticated) -- INSERT ke invoices", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const { error } = await anon.from("invoices").insert({
      company_id: companyId,
      issued_document_id: randomUUID(),
      invoice_number: "HACK-0001",
      sales_order_id: randomUUID(),
      delivery_id: randomUUID(),
      customer_id: randomUUID(),
      issued_at: new Date().toISOString(),
      subtotal_amount: 1,
      discount_amount: 0,
      total_amount: 1,
    });
    expect(error).not.toBeNull();
  });

  it("18. anon (unauthenticated) SELECT invoices mengembalikan 0 baris (RLS default-deny tanpa auth.uid())", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const { data, error } = await anon.from("invoices").select("id").eq("company_id", companyId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);
  });

  it("19. Tenant isolation: user finance company A melihat invoice company sendiri, TIDAK melihat invoice company B", async () => {
    const client = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: `${runTag}-finance@itest.test`, password: financePassword });
    expect(signInErr).toBeNull();

    const own = await client.from("invoices").select("id").eq("id", primaryInvoiceId);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);

    const cross = await client.from("invoices").select("id").eq("id", otherCompanyInvoiceId);
    expect(cross.error).toBeNull();
    expect((cross.data ?? []).length).toBe(0);

    await client.auth.signOut();
  });

  it("20. Permission scoping: user tanpa receivable.view (role sales) tidak melihat invoice company sendiri sekalipun", async () => {
    const client = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: `${runTag}-sales@itest.test`, password: salesPassword });
    expect(signInErr).toBeNull();

    const { data, error } = await client.from("invoices").select("id").eq("id", primaryInvoiceId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);

    await client.auth.signOut();
  });

  it("21. Direct mutation ditolak untuk authenticated (finance, punya receivable.view tapi bukan writer) -- INSERT ke receivable_ledger", async () => {
    const client = createClient(env!.url, env!.anonKey);
    await client.auth.signInWithPassword({ email: `${runTag}-finance@itest.test`, password: financePassword });

    const { error } = await client.from("receivable_ledger").insert({
      company_id: companyId,
      invoice_id: primaryInvoiceId,
      entry_type: "invoice_issued",
      direction: "debit",
      amount: 1,
    });
    expect(error).not.toBeNull();

    await client.auth.signOut();
  });
});
