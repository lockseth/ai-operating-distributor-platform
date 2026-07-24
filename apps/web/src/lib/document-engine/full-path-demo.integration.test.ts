// =============================================================================
// Full production-path demo (DB-backed) -- Target 2/3/4, LOCKED 2026-07-22.
//
// Membuktikan jalur PRODUKSI end-to-end, bukan fixture in-memory:
//   Supabase lokal -> SupabaseDeliveryRepository/SupabaseDocumentIssuanceRepository
//   (repository ASLI) -> ConfirmedOrderReader/DeliveryVerificationReader (adapter
//   ASLI) -> issuePurchaseOrderDocument/issueInvoiceDocument (orkestrasi ASLI)
//   -> issued_documents.snapshot DIBACA ULANG dari DB (bukan nilai in-process)
//   -> buildPrintViewModel + PrintDocumentPanel (renderer ASLI, sudah teruji
//   terpisah di PrintDocumentPanel.test.ts/print-css.test.ts).
//
// Juga membuktikan Target 2 (issue_delivery_note, SEBELUM dispatch) dan Target
// 3 (COMPANY_PROFILE_INCOMPLETE gate) terjalin benar dengan alur delivery
// verification yang sudah ada (recordDispatch/recordArrival/
// finalizeItemQuantities/finalizeDelivery -- repository asli, tidak ditulis
// ulang di sini).
//
// Fixture PRODUK: 7 SKU kanonik ("Pak Waluyo", sama seperti describe
// "Invoice canonical Pak Waluyo" di repository-adapter.test.ts) -- membuktikan
// Kode Barang/Jenis Produk asli bertahan untuk BANYAK baris, bukan hanya satu.
// companies.logo_url diisi data: URI base64 dari aset logo asli
// (docs/document-engine/assets/samples/waluyo) -- SELF-CONTAINED, tidak
// bergantung file/URL eksternal saat dicetak/di-export PDF.
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
import { paginatePrintDocument } from "./print-pagination";
import { PrintDocumentPanel } from "@/components/document-engine/PrintDocumentPanel";
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

/**
 * Logo ASLI PT SUMBER WARNA ALAM SUDIADA (docs/document-engine/assets/samples/
 * waluyo) -- dibaca dari disk lalu di-encode base64 menjadi `data:image/...`
 * SEKALI per run, BUKAN diambil dari URL eksternal. Ini memastikan dokumen
 * yang dihasilkan (HTML/PDF) self-contained: `<img>` membawa byte gambar itu
 * sendiri, tidak merujuk file/URL lain.
 */
function loadLogoDataUri(): string {
  const logoPath = path.resolve(
    __dirname,
    "../../../../../docs/document-engine/assets/samples/waluyo/logo-pt-sumber-warna-alam-sudiada .png",
  );
  const bytes = readFileSync(logoPath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const SCRATCHPAD_DIR =
  "C:\\Users\\PC\\AppData\\Local\\Temp\\claude\\D--PROJECT-AI-Operating-Distributor-Platform\\048d86ef-a77f-482d-b9b5-6e147e5dcc7c\\scratchpad";

/** 7 SKU kanonik "Pak Waluyo" -- sama dengan WALUYO_PRODUCTS di repository-adapter.test.ts, dipakai di sini lewat DB sungguhan (bukan fake reader). */
const WALUYO_PRODUCTS = [
  { sku: "SKU-001", name: "Minyak Goreng 2L", category: "Minyak Goreng", quantity: 20, unitPrice: 210000, discount: 10000 },
  { sku: "SKU-002", name: "Indomie Goreng", category: "Mie Instan", quantity: 15, unitPrice: 85000, discount: 5000 },
  { sku: "SKU-003", name: "Gula Pasir 1Kg", category: "Sembako", quantity: 25, unitPrice: 16000, discount: 0 },
  { sku: "SKU-004", name: "Kecap Manis 600ml", category: "Bumbu Dapur", quantity: 12, unitPrice: 22000, discount: 2000 },
  { sku: "SKU-005", name: "Sabun Cuci Piring 800ml", category: "Perawatan Rumah", quantity: 18, unitPrice: 14500, discount: 0 },
  { sku: "SKU-006", name: "Teh Celup Kotak", category: "Minuman", quantity: 10, unitPrice: 12000, discount: 1000 },
  { sku: "SKU-007", name: "Kopi Sachet Renceng", category: "Minuman", quantity: 30, unitPrice: 21000, discount: 0 },
] as const;

describeIfDb("Full production path: DB lokal -> repository asli -> issued snapshot -> renderer", () => {
  let supabase: SupabaseClient;
  let deliveryRepo: SupabaseDeliveryRepository;
  let issuanceRepo: SupabaseDocumentIssuanceRepository;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const logoDataUri = loadLogoDataUri();
  let salesAuthId = "";
  let customerId = "";
  let orderId = "";
  let orderItemIds: string[] = [];
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    deliveryRepo = new SupabaseDeliveryRepository(supabase);
    issuanceRepo = new SupabaseDocumentIssuanceRepository(supabase);

    await supabase.from("companies").insert({
      id: companyId,
      name: "PT SUMBER WARNA ALAM SUDIADA",
      slug: `fullpath-${runTag}`,
      legal_address: "Jl. Cendana Raya Talun Cirebon 45171",
      contact_email: "sumberwanaalamsudiada@gmail.com",
      contact_phone: "085185905859",
      document_number_prefix: "FPD",
      logo_url: logoDataUri,
    });

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@fullpath.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@fullpath.test`, full_name: "Budi Santoso", is_active: true });
    // create_delivery_atomic (migration 20260823000001) memvalidasi permission
    // delivery.manage untuk actor -- beri role owner supaya createDelivery()
    // repository PRODUKSI di bawah bisa dipanggil sungguhan.
    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    await supabase.from("user_roles").insert({ user_id: salesAuthId, company_id: companyId, role_id: (ownerRole as { id: string }).id });

    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: "Toko Sari Rasa (Pak Waluyo)", code: `CUST-${runTag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    customerId = (customer as { id: string }).id;

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "confirmed", payment_terms_days: 14 })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    orderId = (order as { id: string }).id;

    // products.sku/product_categories.name -- membuktikan Kode Barang/Jenis
    // Produk asli bertahan lewat seluruh jalur produksi (bukan hanya fixture
    // in-process): getConfirmedOrder/getDelivery (join sales_order_item->
    // product->category) -> builder -> issued_documents.snapshot (JSONB) ->
    // dibaca ulang dari DB -> renderer. 7 baris (bukan 1) supaya kanonik
    // "Pak Waluyo" sungguhan lewat DB, bukan hanya fake reader di unit test.
    orderItemIds = [];
    for (const p of WALUYO_PRODUCTS) {
      const { data: category, error: categoryErr } = await supabase
        .from("product_categories")
        .insert({ company_id: companyId, name: p.category })
        .select("id")
        .single();
      if (categoryErr) throw new Error(`gagal buat product_categories (${p.category}): ${categoryErr.message}`);

      const { data: product, error: productErr } = await supabase
        .from("products")
        .insert({ company_id: companyId, sku: `${p.sku}-${runTag}`, name: p.name, category_id: (category as { id: string }).id, price: p.unitPrice, unit: "dus" })
        .select("id")
        .single();
      if (productErr) throw new Error(`gagal buat products (${p.name}): ${productErr.message}`);

      const { data: orderItem, error: itemErr } = await supabase
        .from("sales_order_items")
        .insert({
          order_id: orderId,
          product_id: (product as { id: string }).id,
          quantity: p.quantity,
          unit: "dus",
          unit_price: p.unitPrice,
          discount_amount: p.discount,
          total_amount: p.quantity * p.unitPrice - p.discount,
        })
        .select("id")
        .single();
      if (itemErr) throw new Error(`gagal buat order item (${p.name}): ${itemErr.message}`);
      orderItemIds.push((orderItem as { id: string }).id);
    }
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
      { companyId, orderId, issuedBy: salesAuthId, delivererName: "Budi Santoso" },
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

    // 7 SKU kanonik "Pak Waluyo" -- products.sku/product_categories.name
    // (Kode Barang/Jenis Produk) WAJIB ikut tersimpan dalam snapshot immutable
    // dan bertahan setelah dibaca ulang dari DB -- bukan "-", untuk SETIAP baris.
    expect(snapshotFromDb.lines).toHaveLength(7);
    for (const [i, p] of WALUYO_PRODUCTS.entries()) {
      expect(snapshotFromDb.lines[i]!.productCode).toBe(`${p.sku}-${runTag}`);
      expect(snapshotFromDb.lines[i]!.productCode).not.toBe("-");
      expect(snapshotFromDb.lines[i]!.productType).toBe(p.category);
    }

    const viewModel = buildPrintViewModel(snapshotFromDb);

    // Logo tersedia pada print view model sebagai data URI self-contained
    // (BUKAN URL eksternal) -- tenant.logoUrl langsung dari companies.logo_url.
    expect(viewModel.tenant.logoUrl).not.toBeNull();
    expect(viewModel.tenant.logoUrl).toMatch(/^data:image\/png;base64,/);
    expect(viewModel.tenant.logoUrl).toBe(logoDataUri);

    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: paginatePrintDocument(viewModel)[0]! }));
    // Base64 logo (~1.3 juta karakter acak) bisa secara kebetulan memuat
    // substring seperti "DPP"/"PPN" -- redaksi payload base64 SEBELUM
    // memeriksa larangan teks bisnis, supaya pemeriksaan itu tetap berarti
    // (memeriksa konten dokumen, bukan noise base64 gambar).
    const htmlTextCheck = html.split(logoDataUri).join("[LOGO_DATA_URI]");

    expect(htmlTextCheck).not.toContain("CATATAN");
    expect(htmlTextCheck).not.toContain("DPP");
    expect(htmlTextCheck).not.toContain("PPN");
    // LOCKED 23 Juli 2026 (final): SATU panel = SATU dokumen, tanda tangan Salesman/Pengirim/Penerima.
    expect(html.match(/doc-engine-signature-role">SALESMAN</g)).toHaveLength(1);
    expect(html.match(/doc-engine-signature-role">PENGIRIM</g)).toHaveLength(1);
    expect(html.match(/doc-engine-signature-role">PENERIMA</g)).toHaveLength(1);
    expect(html).not.toContain("DITERIMA OLEH");
    expect(html.match(/class="doc-engine-panel"/g)).toHaveLength(1);
    expect(html).not.toContain("doc-engine-perforation");
    expect(html).toContain(issued.record.documentNumber);
    expect(html).toContain("Toko Sari Rasa (Pak Waluyo)");
    // Logo BENAR-BENAR tertanam pada markup yang dirender (data: URI utuh di
    // dalam <img>, bukan sekadar path/URL) -- inilah yang Chromium/Playwright
    // embed sebagai byte gambar sungguhan saat dokumen ini di-export ke PDF.
    expect(html).toContain(`<img src="${logoDataUri}"`);
    expect(html).toContain('class="doc-engine-logo"');
    for (const p of WALUYO_PRODUCTS) {
      expect(html).toContain(`<td>${p.sku}-${runTag}</td>`);
      expect(html).toContain(`<td>${p.category}</td>`);
    }

    writeFileSync(path.join(SCRATCHPAD_DIR, "full-path-demo-po.html"), renderStandaloneHtml(html), "utf-8");
  });

  it("2. Delivery Note (Target 2) diterbitkan SEBELUM dispatch, lalu delivery diverifikasi penuh (7 baris) lewat repository asli", async () => {
    const created = await deliveryRepo.createDelivery({
      companyId,
      actorId: salesAuthId,
      salesOrderId: orderId,
      idempotencyKey: null,
      driverId: salesAuthId,
      items: WALUYO_PRODUCTS.map((p, i) => ({ salesOrderItemId: orderItemIds[i]!, productName: p.name, unit: "dus", unitPrice: p.unitPrice, orderedQuantity: p.quantity })),
    });
    deliveryId = created.id;
    expect(created.status).toBe("planned");
    expect(created.items).toHaveLength(7);

    // Target 2: Surat Jalan WAJIB diterbitkan sebelum dispatch.
    const note = await issuanceRepo.issueDeliveryNote(deliveryId);
    expect(note.deliveryNumber).toMatch(/^FPD-SJ-\d{8}-\d{6}$/);

    await deliveryRepo.recordDispatch(deliveryId);
    await deliveryRepo.recordArrival(deliveryId);
    const finalizeResult = await deliveryRepo.finalizeItemQuantities(
      deliveryId,
      created.items.map((item, i) => ({
        deliveryItemId: item.id,
        receivedQuantity: WALUYO_PRODUCTS[i]!.quantity,
        rejectedQuantity: 0,
        returnedQuantity: 0,
        unresolvedQuantity: 0,
      })),
    );
    expect(finalizeResult.ok).toBe(true);
    const finalized = await deliveryRepo.finalizeDelivery(deliveryId, "fully_received");
    expect(finalized.delivery.status).toBe("fully_received");
  });

  it("3. Invoice: menagih verifiedQuantity via jalur produksi (7 baris), deliveryReference = nomor Surat Jalan Target 2, disimpan sebagai version 1", async () => {
    const orderReader = new ConfirmedOrderReader(deliveryRepo);
    const deliveryReader = new DeliveryVerificationReader(deliveryRepo);

    const issued = await issueInvoiceDocument(
      { issuance: issuanceRepo, orderReader, deliveryReader },
      { companyId, orderId, deliveryId, issuedBy: salesAuthId, delivererName: "Budi Santoso" },
    );

    expect(issued.record.documentNumber).toMatch(/^FPD-INV-\d{8}-\d{6}$/);
    expect(issued.snapshot.deliveryReference).toMatch(/^FPD-SJ-\d{8}-\d{6}$/);
    expect(issued.snapshot.lines).toHaveLength(7);
    for (const [i, p] of WALUYO_PRODUCTS.entries()) {
      expect(issued.snapshot.lines[i]!.quantity).toBe(p.quantity); // verifiedQuantity, bukan ordered mentah
    }

    const { data: row } = await supabase.from("issued_documents").select("snapshot, source_order_id, source_delivery_id").eq("id", issued.record.id).single();
    const snapshotFromDb = (row as { snapshot: DocumentSnapshot }).snapshot;
    expect((row as { source_order_id: string }).source_order_id).toBe(orderId);
    expect((row as { source_delivery_id: string }).source_delivery_id).toBe(deliveryId);

    // 7 SKU kanonik "Pak Waluyo" WAJIB ikut ditagih (Invoice via
    // DeliveryVerificationReader -> computeInvoiceEligibility), bertahan
    // setelah snapshot dibaca ulang dari DB -- bukan "-", untuk SETIAP baris.
    expect(snapshotFromDb.lines).toHaveLength(7);
    for (const [i, p] of WALUYO_PRODUCTS.entries()) {
      expect(snapshotFromDb.lines[i]!.productCode).toBe(`${p.sku}-${runTag}`);
      expect(snapshotFromDb.lines[i]!.productCode).not.toBe("-");
      expect(snapshotFromDb.lines[i]!.productType).toBe(p.category);
    }

    const viewModel = buildPrintViewModel(snapshotFromDb);

    // Logo tersedia pada print view model Invoice juga (branding sama, bukan
    // hanya PO) -- data URI self-contained, sama persis dengan companies.logo_url.
    expect(viewModel.tenant.logoUrl).not.toBeNull();
    expect(viewModel.tenant.logoUrl).toMatch(/^data:image\/png;base64,/);
    expect(viewModel.tenant.logoUrl).toBe(logoDataUri);

    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: paginatePrintDocument(viewModel)[0]! }));
    // Lihat catatan di test 1 -- redaksi payload base64 logo sebelum memeriksa larangan teks bisnis.
    const htmlTextCheck = html.split(logoDataUri).join("[LOGO_DATA_URI]");
    expect(htmlTextCheck).not.toContain("CATATAN");
    expect(htmlTextCheck).not.toContain("DPP");
    expect(htmlTextCheck).not.toContain("PPN");
    // Baris terpisah per kolom (label/":"/value) di layout baru, bukan "Label: value" satu string.
    expect(html).toContain("Ref. Delivery");
    expect(html).toContain(`<td>${issued.snapshot.deliveryReference}</td>`);
    // Logo BENAR-BENAR tertanam pada markup Invoice juga.
    expect(html).toContain(`<img src="${logoDataUri}"`);
    expect(html).toContain('class="doc-engine-logo"');
    for (const p of WALUYO_PRODUCTS) {
      expect(html).toContain(`<td>${p.sku}-${runTag}</td>`);
      expect(html).toContain(`<td>${p.category}</td>`);
    }

    writeFileSync(path.join(SCRATCHPAD_DIR, "full-path-demo-invoice.html"), renderStandaloneHtml(html), "utf-8");
  });
});
