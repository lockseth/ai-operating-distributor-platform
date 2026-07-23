// =============================================================================
// Renderer test -- dirender ke string statis (react-dom/server), TIDAK
// memakai jsdom/browser dan TIDAK menyentuh repository/database sama sekali
// (test 18: renderer tidak melakukan query). Snapshot dibangun murni dari
// fixture in-memory lewat builder Document Engine yang sudah diuji terpisah.
//
// File ini SENGAJA .test.ts (bukan .test.tsx) dan memakai React.createElement
// (bukan sintaks JSX) -- proyek ini hanya menjalankan test lewat pola
// src/**/*.test.ts (dikonfirmasi lewat percobaan run langsung), mengubah
// pola tsx test runner di luar scope modul Document Engine.
//
// Menguji PrintDocumentPanel (SATU halaman cetak, TANPA wrapper sheet
// fisik -- itu tanggung jawab PhysicalPrintSheet.test.ts). Komponen
// menerima PaginatedPrintPanel (lib/document-engine/print-pagination.ts),
// jadi setiap PrintDocumentViewModel di sini di-paginate dulu via
// toPanel()/toPanels() sebelum dirender.
// =============================================================================

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildInvoiceSnapshot } from "@/lib/document-engine/invoice-builder";
import { buildPurchaseOrderSnapshot } from "@/lib/document-engine/po-builder";
import { buildPrintViewModel, type PrintDocumentViewModel } from "@/lib/document-engine/print-view-model";
import { paginatePrintDocument } from "@/lib/document-engine/print-pagination";
import type { DeliverySource, OrderLineSource, OrderSource, TenantIdentity } from "@/lib/document-engine/types";
import { PrintDocumentPanel } from "./PrintDocumentPanel";

const SWA_TENANT: TenantIdentity = {
  companyId: "company-swa",
  companyName: "PT SUMBER WARNA ALAM SUDIADA",
  companyAddress: "Jl. Cendana Raya Talun Cirebon 45171",
  companyEmail: "sumberwanaalamsudiada@gmail.com",
  companyPhone: "085185905859",
  logoUrl: null,
};

function orderLine(overrides: Partial<OrderLineSource> = {}): OrderLineSource {
  return {
    orderLineId: "line-1",
    productCode: "SKU-1",
    productName: "Indomie Goreng",
    productType: "Mie Instan",
    unit: "dus",
    quantity: 10,
    unitPrice: 85000,
    discountAmount: 5000,
    ...overrides,
  };
}

function order(overrides: Partial<OrderSource> = {}): OrderSource {
  return {
    orderId: "order-A",
    companyId: "company-swa",
    orderNumber: "SO-0001",
    orderDate: "2026-08-10",
    store: { customerId: "cust-1", storeCode: "CUST-1", storeName: "Toko Sari", storeAddress: "Jl. Mangga 1", storePhone: "081200000001", picName: "Ibu Sari" },
    salesman: { salesmanId: "sales-1", salesmanName: "Budi" },
    lines: [orderLine()],
    paymentTermsDays: 14,
    ...overrides,
  };
}

function delivery(overrides: Partial<DeliverySource> = {}): DeliverySource {
  return {
    deliveryId: "delivery-A",
    companyId: "company-swa",
    orderId: "order-A",
    deliveryNumber: "DO-0001",
    deliveryDate: "2026-08-11",
    billingStatus: "ELIGIBLE",
    lines: [
      {
        deliveryLineId: "dline-1",
        orderLineId: "line-1",
        productCode: "SKU-1",
        productName: "Indomie Goreng",
        productType: "Mie Instan",
        unit: "dus",
        orderedQuantity: 10,
        verifiedQuantity: 10,
        unitPrice: 85000,
        discountAmount: 5000,
      },
    ],
    ...overrides,
  };
}

/** Dokumen pendek (1 panel) -> panel satu-satunya, untuk test yang tidak peduli continuation. */
function toPanel(vm: PrintDocumentViewModel) {
  return paginatePrintDocument(vm)[0]!;
}

function renderInvoiceHtml(): string {
  const snapshot = buildInvoiceSnapshot({
    order: order(),
    delivery: delivery(),
    tenant: SWA_TENANT,
    documentNumber: "INV-20260811-000001",
    documentDate: "2026-08-11",
  });
  const viewModel = buildPrintViewModel(snapshot);
  return renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: toPanel(viewModel) }));
}

describe("PrintDocumentPanel -- 11, 12, 16, 18", () => {
  it("11. Output TIDAK mengandung teks 'CATATAN' dalam bentuk apa pun", () => {
    const html = renderInvoiceHtml();
    expect(html.toUpperCase()).not.toContain("CATATAN");
  });

  it("12. Output memiliki tiga label tanda tangan: SALESMAN, PENGIRIM, PENERIMA (LOCK Founder 23 Juli 2026, wording final)", () => {
    const html = renderInvoiceHtml();
    expect(html).toContain(">SALESMAN<");
    expect(html).toContain(">PENGIRIM<");
    expect(html).toContain(">PENERIMA<");
    expect(html).not.toContain("DITERIMA OLEH");
    expect(html).not.toContain("Disiapkan Oleh");
    expect(html.toUpperCase()).not.toContain("DISIAPKAN OLEH");
  });

  it("Salesman, Pengirim, dan Penerima tetap tiga area terpisah dan berurutan walau nama orangnya sama", () => {
    const html = renderInvoiceHtml();
    const salesmanBlockIndex = html.indexOf(">SALESMAN<");
    const pengirimBlockIndex = html.indexOf(">PENGIRIM<");
    const penerimaBlockIndex = html.indexOf(">PENERIMA<");
    expect(salesmanBlockIndex).toBeGreaterThan(-1);
    expect(pengirimBlockIndex).toBeGreaterThan(salesmanBlockIndex);
    expect(penerimaBlockIndex).toBeGreaterThan(pengirimBlockIndex);
  });

  it("16. Branding hanya PT Sumber Warna Alam Sudiada -- data kontak sesuai spesifikasi LOCKED", () => {
    const html = renderInvoiceHtml();
    expect(html).toContain("PT SUMBER WARNA ALAM SUDIADA");
    expect(html).toContain("Jl. Cendana Raya Talun Cirebon 45171");
    expect(html).toContain("sumberwanaalamsudiada@gmail.com");
    expect(html).toContain("085185905859");
  });

  it("tidak ada branding perusahaan lain tercampur (mis. Waluyo Distributor dari modul lain)", () => {
    const html = renderInvoiceHtml();
    expect(html).not.toContain("Waluyo Distributor");
  });

  it("tidak menampilkan GPS map, Route Intelligence, atau fitur Surabraja", () => {
    const html = renderInvoiceHtml();
    const upper = html.toUpperCase();
    expect(upper).not.toContain("GPS");
    expect(upper).not.toContain("ROUTE INTELLIGENCE");
    expect(upper).not.toContain("SURABRAJA");
  });

  it("tidak ada textarea catatan kosong", () => {
    const html = renderInvoiceHtml();
    expect(html).not.toContain("<textarea");
  });

  it("REGRESSION LOCKED (final): HANYA SATU document panel per render -- tidak ada duplikasi konten, dan root elemen adalah .doc-engine-panel (BUKAN .doc-engine-page/sheet -- itu tanggung jawab PhysicalPrintSheet), TIDAK ADA perforasi", () => {
    const html = renderInvoiceHtml();
    const panelCount = (html.match(/class="doc-engine-panel"/g) ?? []).length;
    expect(panelCount).toBe(1);
    expect(html).not.toContain('class="doc-engine-page"');
    expect(html).not.toContain('class="doc-engine-sheet"');
    expect(html).not.toContain("doc-engine-perforation");
    // data-document-number HANYA muncul sekali -- bukti tidak ada wrapper kedua yang identik.
    const docNumberAttrCount = (html.match(/data-document-number="/g) ?? []).length;
    expect(docNumberAttrCount).toBe(1);
    // Baris "No. Dokumen" (konten tabel metadata yang terlihat) hanya tercetak sekali.
    const visibleMetaRowCount = (html.match(/>No\. Dokumen</g) ?? []).length;
    expect(visibleMetaRowCount).toBe(1);
  });

  it("dokumen 1 panel (bukan continuation) TIDAK menampilkan indikator Halaman X/N atau penanda Bersambung", () => {
    const html = renderInvoiceHtml();
    expect(html).not.toContain("Halaman");
    expect(html).not.toContain("Bersambung");
  });

  it("LOCKED: Totals menampilkan Terbilang, TIDAK PERNAH menampilkan DPP/PPN/Other Charges (kontrak aktif Pak Waluyo)", () => {
    const html = renderInvoiceHtml();
    expect(html).toContain("Terbilang:");
    const upper = html.toUpperCase();
    expect(upper).not.toContain("DPP");
    expect(upper).not.toContain("PPN");
    expect(upper).not.toContain("OTHER CHARGES");
  });

  it("nomor dokumen PO dan Invoice sama-sama dapat dirender (dua tipe dokumen)", () => {
    const poSnapshot = buildPurchaseOrderSnapshot({
      order: order(),
      tenant: SWA_TENANT,
      documentNumber: "PO-20260810-000001",
      documentDate: "2026-08-10",
    });
    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: toPanel(buildPrintViewModel(poSnapshot)) }));
    expect(html).toContain("PURCHASE ORDER");
    expect(html).not.toContain("Ref. Delivery"); // PO tidak punya delivery reference
  });

  it("REGRESSION 2026-07-23: panel KETENTUAN PEMBAYARAN terpisah DAN heading/badge-nya DIHAPUS -- panel DATA TOKO/CUSTOMER full-width dengan dua kolom internal", () => {
    const html = renderInvoiceHtml();
    expect(html).not.toContain("KETENTUAN PEMBAYARAN");
    expect(html).not.toContain("Termin Pembayaran");
    expect(html).not.toContain("doc-engine-panel-badge");
    // Hanya SATU panel info (DATA TOKO/CUSTOMER) yang tersisa pada info-row, disusun dua kolom internal.
    expect((html.match(/class="doc-engine-info-panel"/g) ?? []).length).toBe(1);
    expect((html.match(/class="doc-engine-info-column"/g) ?? []).length).toBe(2);
  });

  it("REGRESSION: teks 'Tempo' HANYA muncul satu kali (meta-box header) ketika data tersedia -- TIDAK diulang di panel DATA TOKO/CUSTOMER", () => {
    const html = renderInvoiceHtml();
    expect((html.match(/>Tempo</g) ?? []).length).toBe(1);
    expect(html).not.toContain("<td>TEMPO</td>");
    // Satu-satunya sumber tempo pembayaran: due date lengkap di meta-box header ("6 Agustus 2026 (14 Hari)"), bukan baris ringkas terpisah.
    expect(html).toContain("(14 Hari)");
  });

  it("teks 'Tempo' tidak muncul sama sekali bila paymentTermsDays null (baik di header maupun panel)", () => {
    const snapshot = buildPurchaseOrderSnapshot({
      order: order({ paymentTermsDays: null }),
      tenant: SWA_TENANT,
      documentNumber: "PO-20260810-000002",
      documentDate: "2026-08-10",
    });
    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: toPanel(buildPrintViewModel(snapshot)) }));
    expect(html).not.toContain(">Tempo<");
    expect(html).not.toContain("<td>TEMPO</td>");
  });
});

describe("PrintDocumentPanel -- continuation panel (LOCK 'AODP WALUYO -- CONTINUATION PANEL PRINT GATE')", () => {
  function longOrder(lineCount: number): OrderSource {
    return order({
      lines: Array.from({ length: lineCount }, (_, i) => orderLine({ orderLineId: `line-${i + 1}`, productCode: `SKU-${i + 1}`, productName: `Produk ${i + 1}` })),
    });
  }

  it("panel pertama (non-final) dari dokumen 25 item: indikator Halaman 1/3, penanda Bersambung, TIDAK ADA total/tanda tangan", () => {
    const snapshot = buildPurchaseOrderSnapshot({ order: longOrder(25), tenant: SWA_TENANT, documentNumber: "PO-25ITEMS", documentDate: "2026-08-10" });
    const panels = paginatePrintDocument(buildPrintViewModel(snapshot), 10);
    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: panels[0]! }));
    expect(html).toContain("1/3");
    expect(html).toContain("Bersambung");
    expect(html).not.toContain("GRAND TOTAL");
    expect(html).not.toContain("Terbilang");
    expect(html).not.toContain(">SALESMAN<");
    expect(html).not.toContain(">PENGIRIM<");
    expect(html).not.toContain(">PENERIMA<");
    expect((html.match(/<tr>/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain("SKU-1");
    expect(html).toContain("SKU-10");
    expect(html).not.toContain(">SKU-11<");
  });

  it("panel kedua (non-final) memuat item 11-20, identitas dokumen SAMA, TIDAK ADA total/tanda tangan", () => {
    const snapshot = buildPurchaseOrderSnapshot({ order: longOrder(25), tenant: SWA_TENANT, documentNumber: "PO-25ITEMS", documentDate: "2026-08-10" });
    const panels = paginatePrintDocument(buildPrintViewModel(snapshot), 10);
    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: panels[1]! }));
    expect(html).toContain("2/3");
    expect(html).toContain("PO-25ITEMS");
    expect(html).toContain("Bersambung");
    expect(html).not.toContain("GRAND TOTAL");
    expect(html).toContain(">SKU-11<");
    expect(html).toContain(">SKU-20<");
  });

  it("panel final (3/3) menampilkan sisa item, GRAND TOTAL, Terbilang, dan tanda tangan Salesman/Pengirim/Penerima -- TIDAK ADA penanda Bersambung", () => {
    const snapshot = buildPurchaseOrderSnapshot({ order: longOrder(25), tenant: SWA_TENANT, documentNumber: "PO-25ITEMS", documentDate: "2026-08-10" });
    const panels = paginatePrintDocument(buildPrintViewModel(snapshot), 10);
    const html = renderToStaticMarkup(createElement(PrintDocumentPanel, { panel: panels[2]! }));
    expect(html).toContain("3/3");
    expect(html).toContain("GRAND TOTAL");
    expect(html).toContain("Terbilang");
    expect(html).toContain(">SALESMAN<");
    expect(html).toContain(">PENGIRIM<");
    expect(html).toContain(">PENERIMA<");
    expect(html).not.toContain("Bersambung");
    expect(html).toContain(">SKU-21<");
    expect(html).toContain(">SKU-25<");
    expect(html).not.toContain(">SKU-26<");
  });
});

describe("18. Renderer tidak melakukan repository/database query", () => {
  it("PrintDocumentPanel.tsx tidak mengimpor Supabase client atau modul repository apa pun", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "./PrintDocumentPanel.tsx"), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(source).not.toMatch(/@supabase\/supabase-js/);
    expect(source).not.toMatch(/getAdminClient|createClient\(/);
    expect(importLines).not.toMatch(/repository/i);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
