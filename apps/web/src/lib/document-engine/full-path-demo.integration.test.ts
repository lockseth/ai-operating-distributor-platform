// =============================================================================
// Full production-path demo (DB-backed) -- Target 2/3/4, LOCKED 2026-07-22.
//
// Membuktikan jalur PRODUKSI end-to-end, bukan fixture in-memory:
//   Supabase lokal -> SupabaseDeliveryRepository/SupabaseDocumentIssuanceRepository
//   (repository ASLI) -> ConfirmedOrderReader/DeliveryVerificationReader (adapter
//   ASLI) -> issuePurchaseOrderDocument/issueInvoiceDocument (orkestrasi ASLI)
//   -> issued_documents.snapshot DIBACA ULANG dari DB (bukan nilai in-process)
//   -> buildPrintViewModel + PrintDocumentPage (renderer ASLI, sudah teruji
//   terpisah di PrintDocumentPage.test.ts/print-css.test.ts).
//
// Juga membuktikan Target 2 (issue_delivery_note, SEBELUM dispatch) dan Target
// 3 (COMPANY_PROFILE_INCOMPLETE gate) terjalin benar dengan alur delivery
// verification yang sudah ada (recordDispatch/recordArrival/
// finalizeItemQuantities/finalizeDelivery -- repository asli, tidak ditulis
// ulang di sini).
//
// Fixture terisolasi per run (companyId/order/delivery UUID acak + runTag),
// dibersihkan di afterAll. Skip graceful bila Supabase lokal tidak tersedia
// (pola sama seperti issuance-repository.integration.test.ts).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";
import { SupabaseDocumentIssuanceRepository } from "./issuance-repository";
import { ConfirmedOrderReader, DeliveryVerificationReader } from "./repository-adapter";
import { issueInvoiceDocument, issuePurchaseOrderDocument } from "./issuance";
import { buildPrintViewModel } from "./print-view-model";
import { PrintDocumentPage } from "@/components/document-engine/PrintDocumentPage";
import type { DocumentSnapshot } from "./types";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
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
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
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

/** Menyusun HTML mandiri (print.css disisipkan inline) untuk pemeriksaan visual di luar test runner -- ditulis ke scratchpad, TIDAK ke working tree repo. */
function renderStandaloneHtml(bodyHtml: string): string {
  const cssPath = path.resolve(__dirname, "../../components/document-engine/print.css");
  const css = readFileSync(cssPath, "utf-8");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Full Path Demo</title><style>${css}</style></head><body>${bodyHtml}</body></html>`;
}

const SCRATCHPAD_DIR = "C:\\Users\\PC\\AppData\\Local\\Temp\\claude\\D--PROJECT-AI-Operating-Distributor-Platform\\034846e4-7a79-42e2-83ea-708be9047beb\\scratchpad";

describeIfDb("Full production path: DB lokal -> repository asli -> issued snapshot -> renderer", () => {
  let supabase: SupabaseClient;
  let deliveryRepo: SupabaseDeliveryRepository;
  let issuanceRepo: SupabaseDocumentIssuanceRepository;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let salesAuthId = "";
  let customerId = "";
  let orderId = "";
  let orderItemId = "";
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    deliveryRepo = new SupabaseDeliveryRepository(supabase);
    issuanceRepo = new SupabaseDocumentIssuanceRepository(supabase);

    await supabase.from("companies").insert({
      id: companyId,
      name: "PT Full Path Demo",
      slug: `fullpath-${runTag}`,
      legal_address: "Jl. Demo Jalur Produksi No. 88, Cirebon",
      contact_email: "demo@fullpath.test",
      contact_phone: "021-5550188",
      document_number_prefix: "FPD",
    });

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@fullpath.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@fullpath.test`, full_name: "Sales Demo", is_active: true });

    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: "Toko Demo Jalur Produksi", code: `CUST-${runTag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    customerId = (customer as { id: string }).id;

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "confirmed" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    orderId = (order as { id: string }).id;

    const { data: orderItem, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({
        order_id: orderId,
        product_name_raw: "Minyak Goreng 2L",
        quantity: 20,
        unit: "dus",
        unit_price: 210000,
        discount_amount: 10000,
        total_amount: 20 * 210000 - 10000,
      })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    orderItemId = (orderItem as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("issued_documents").delete().eq("company_id", companyId);
    if (deliveryId) await supabase.from("delivery_items").delete().eq("delivery_id", deliveryId);
    await supabase.from("deliveries").delete().eq("company_id", companyId);
    await supabase.from("sales_order_items").delete().eq("order_id", orderId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("company_id", companyId);
    await supabase.from("document_number_counters").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("company_id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
  }, 30000);

  it("1. Purchase Order: repository asli -> issuance -> issued_documents dibaca ulang dari DB -> renderer, layout LOCKED", async () => {
    const orderReader = new ConfirmedOrderReader(deliveryRepo);

    const issued = await issuePurchaseOrderDocument(
      { issuance: issuanceRepo, orderReader },
      { companyId, orderId, issuedBy: salesAuthId, delivererName: "Sales Demo" },
    );

    expect(issued.record.documentNumber).toMatch(/^FPD-PO-\d{8}-\d{6}$/);
    expect(issued.record.version).toBe(1);

    // Dibaca ulang LANGSUNG dari database -- bukan nilai in-process -- untuk
    // membuktikan roundtrip persistence sungguhan, bukan sekadar return value.
    const { data: row, error } = await supabase.from("issued_documents").select("snapshot, document_number, document_type").eq("id", issued.record.id).single();
    expect(error).toBeNull();
    const snapshotFromDb = (row as { snapshot: DocumentSnapshot }).snapshot;
    expect(snapshotFromDb.documentNumber).toBe(issued.record.documentNumber);
    expect((row as { document_type: string }).document_type).toBe("PURCHASE_ORDER");

    const viewModel = buildPrintViewModel(snapshotFromDb);
    const html = renderToStaticMarkup(createElement(PrintDocumentPage, { viewModel }));

    expect(html).not.toContain("CATATAN");
    expect(html).not.toContain("DPP");
    expect(html).not.toContain("PPN");
    expect(html.match(/doc-engine-signature-role">Salesman/g)).toHaveLength(2); // 2 panel identik
    expect(html.match(/doc-engine-signature-role">Pengirim/g)).toHaveLength(2);
    expect(html.match(/doc-engine-signature-role">Penerima/g)).toHaveLength(2);
    expect(html).toContain(issued.record.documentNumber);
    expect(html).toContain("Toko Demo Jalur Produksi");

    writeFileSync(path.join(SCRATCHPAD_DIR, "full-path-demo-po.html"), renderStandaloneHtml(html), "utf-8");
  });

  it("2. Delivery Note (Target 2) diterbitkan SEBELUM dispatch, lalu delivery diverifikasi penuh lewat repository asli", async () => {
    const created = await deliveryRepo.createDelivery({
      companyId,
      salesOrderId: orderId,
      idempotencyKey: null,
      createdBy: salesAuthId,
      items: [{ salesOrderItemId: orderItemId, productName: "Minyak Goreng 2L", unit: "dus", unitPrice: 210000, orderedQuantity: 20 }],
    });
    deliveryId = created.id;
    expect(created.status).toBe("planned");

    // Target 2: Surat Jalan WAJIB diterbitkan sebelum dispatch.
    const note = await issuanceRepo.issueDeliveryNote(deliveryId);
    expect(note.deliveryNumber).toMatch(/^FPD-SJ-\d{8}-\d{6}$/);

    await deliveryRepo.recordDispatch(deliveryId);
    await deliveryRepo.recordArrival(deliveryId);
    const finalizeResult = await deliveryRepo.finalizeItemQuantities(deliveryId, [
      { deliveryItemId: created.items[0].id, receivedQuantity: 20, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 },
    ]);
    expect(finalizeResult.ok).toBe(true);
    const finalized = await deliveryRepo.finalizeDelivery(deliveryId, "fully_received");
    expect(finalized.delivery.status).toBe("fully_received");
  });

  it("3. Invoice: menagih verifiedQuantity via jalur produksi, deliveryReference = nomor Surat Jalan Target 2, disimpan sebagai version 1", async () => {
    const orderReader = new ConfirmedOrderReader(deliveryRepo);
    const deliveryReader = new DeliveryVerificationReader(deliveryRepo);

    const issued = await issueInvoiceDocument(
      { issuance: issuanceRepo, orderReader, deliveryReader },
      { companyId, orderId, deliveryId, issuedBy: salesAuthId, delivererName: "Sales Demo" },
    );

    expect(issued.record.documentNumber).toMatch(/^FPD-INV-\d{8}-\d{6}$/);
    expect(issued.snapshot.deliveryReference).toMatch(/^FPD-SJ-\d{8}-\d{6}$/);
    expect(issued.snapshot.lines[0].quantity).toBe(20); // verifiedQuantity, bukan ordered mentah

    const { data: row } = await supabase.from("issued_documents").select("snapshot, source_order_id, source_delivery_id").eq("id", issued.record.id).single();
    const snapshotFromDb = (row as { snapshot: DocumentSnapshot }).snapshot;
    expect((row as { source_order_id: string }).source_order_id).toBe(orderId);
    expect((row as { source_delivery_id: string }).source_delivery_id).toBe(deliveryId);

    const viewModel = buildPrintViewModel(snapshotFromDb);
    const html = renderToStaticMarkup(createElement(PrintDocumentPage, { viewModel }));
    expect(html).not.toContain("CATATAN");
    expect(html).not.toContain("DPP");
    expect(html).not.toContain("PPN");
    expect(html).toContain(`Ref. Delivery: ${issued.snapshot.deliveryReference}`);

    writeFileSync(path.join(SCRATCHPAD_DIR, "full-path-demo-invoice.html"), renderStandaloneHtml(html), "utf-8");
  });
});
