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
// =============================================================================

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildInvoiceSnapshot } from "@/lib/document-engine/invoice-builder";
import { buildPurchaseOrderSnapshot } from "@/lib/document-engine/po-builder";
import { buildPrintViewModel } from "@/lib/document-engine/print-view-model";
import type { DeliverySource, OrderLineSource, OrderSource, TenantIdentity } from "@/lib/document-engine/types";
import { PrintDocumentPage } from "./PrintDocumentPage";

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
    store: { customerId: "cust-1", storeName: "Toko Sari", storeAddress: "Jl. Mangga 1", picName: "Ibu Sari" },
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

function renderInvoiceHtml(): string {
  const snapshot = buildInvoiceSnapshot({
    order: order(),
    delivery: delivery(),
    tenant: SWA_TENANT,
    documentNumber: "INV-20260811-000001",
    documentDate: "2026-08-11",
  });
  const viewModel = buildPrintViewModel(snapshot);
  return renderToStaticMarkup(createElement(PrintDocumentPage, { viewModel }));
}

describe("PrintDocumentPage -- 11, 12, 16, 18", () => {
  it("11. Output TIDAK mengandung teks 'CATATAN' dalam bentuk apa pun", () => {
    const html = renderInvoiceHtml();
    expect(html.toUpperCase()).not.toContain("CATATAN");
  });

  it("12. Output memiliki tiga label tanda tangan: Salesman, Pengirim, Penerima", () => {
    const html = renderInvoiceHtml();
    expect(html).toContain(">Salesman<");
    expect(html).toContain(">Pengirim<");
    expect(html).toContain(">Penerima<");
  });

  it("Salesman dan Pengirim tetap dua area terpisah walau nama orangnya sama", () => {
    const html = renderInvoiceHtml();
    const salesmanBlockIndex = html.indexOf(">Salesman<");
    const pengirimBlockIndex = html.indexOf(">Pengirim<");
    const penerimaBlockIndex = html.indexOf(">Penerima<");
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

  it("dua panel muncul dalam satu halaman (data-document-number sama pada wrapper tunggal)", () => {
    const html = renderInvoiceHtml();
    const panelCount = (html.match(/doc-engine-panel"/g) ?? []).length;
    expect(panelCount).toBe(2);
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
    const html = renderToStaticMarkup(createElement(PrintDocumentPage, { viewModel: buildPrintViewModel(poSnapshot) }));
    expect(html).toContain("PURCHASE ORDER");
    expect(html).not.toContain("Ref. Delivery"); // PO tidak punya delivery reference
  });
});

describe("18. Renderer tidak melakukan repository/database query", () => {
  it("PrintDocumentPage.tsx tidak mengimpor Supabase client atau modul repository apa pun", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "./PrintDocumentPage.tsx"), "utf-8");
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
