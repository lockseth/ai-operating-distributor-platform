// =============================================================================
// PhysicalPrintSheet test -- membuktikan satu physical sheet (9.5x11in)
// berisi dua panel transaksi independen (top/bottom), boundary yang benar,
// identitas/tenant tidak bocor antar-panel, dan slot bawah kosong pada
// jumlah transaksi ganjil TIDAK menghasilkan dummy document.
//
// Dirender ke string statis (react-dom/server), TIDAK memakai jsdom/browser,
// menggunakan React.createElement (pola sama seperti PrintDocumentPanel.test.ts).
// =============================================================================

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildInvoiceSnapshot } from "@/lib/document-engine/invoice-builder";
import { buildPurchaseOrderSnapshot } from "@/lib/document-engine/po-builder";
import { buildPrintViewModel } from "@/lib/document-engine/print-view-model";
import { buildPrintSheets } from "@/lib/document-engine/print-batch";
import type { DeliverySource, OrderLineSource, OrderSource, TenantIdentity } from "@/lib/document-engine/types";
import { PhysicalPrintSheet } from "./PhysicalPrintSheet";

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

function invoiceViewModel(documentNumber: string, storeName: string) {
  const snapshot = buildInvoiceSnapshot({
    order: order({ store: { customerId: "cust-1", storeCode: "CUST-1", storeName, storeAddress: "Jl. Mangga 1", storePhone: "081200000001", picName: "Ibu Sari" } }),
    delivery: delivery(),
    tenant: SWA_TENANT,
    documentNumber,
    documentDate: "2026-08-11",
  });
  return buildPrintViewModel(snapshot);
}

function poViewModel(documentNumber: string, storeName: string) {
  const snapshot = buildPurchaseOrderSnapshot({
    order: order({ store: { customerId: "cust-2", storeCode: "CUST-2", storeName, storeAddress: "Jl. Kenanga 2", storePhone: "081200000002", picName: "Pak Anto" } }),
    tenant: SWA_TENANT,
    documentNumber,
    documentDate: "2026-08-10",
  });
  return buildPrintViewModel(snapshot);
}

describe("PhysicalPrintSheet -- dua transaksi per lembar fisik", () => {
  it("dua transaksi berbeda menempati panel atas dan bawah, boundary benar (atas sebelum bawah), tidak ada kebocoran data", () => {
    const top = invoiceViewModel("INV-20260811-000001", "Toko Sari");
    const bottom = poViewModel("PO-20260810-000009", "Toko Kenanga");
    const [sheet] = buildPrintSheets([top, bottom]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet! }));

    expect(html).toContain('class="doc-engine-sheet"');
    expect((html.match(/class="doc-engine-panel"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-empty-panel="true"');

    const topIndex = html.indexOf("INV-20260811-000001");
    const bottomIndex = html.indexOf("PO-20260810-000009");
    expect(topIndex).toBeGreaterThan(-1);
    expect(bottomIndex).toBeGreaterThan(-1);
    expect(topIndex).toBeLessThan(bottomIndex);

    expect(html).toContain("Toko Sari");
    expect(html).toContain("Toko Kenanga");
    // Nomor dokumen tidak tertukar antar panel.
    expect(html.indexOf("Toko Sari")).toBeLessThan(html.indexOf("Toko Kenanga"));

    expect(html).toContain(`data-top-document-number="INV-20260811-000001"`);
    expect(html).toContain(`data-bottom-document-number="PO-20260810-000009"`);
  });

  it("jumlah transaksi ganjil -- slot bawah sheet terakhir kosong, TIDAK ADA dummy document, tidak ada header/tanda tangan/nomor karangan", () => {
    const only = invoiceViewModel("INV-20260811-000002", "Toko Tunggal");
    const [sheet] = buildPrintSheets([only]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet! }));

    expect((html.match(/class="doc-engine-panel"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-empty-panel="true"');
    expect(html).toContain('data-bottom-document-number=""');
    // Panel kosong tidak memiliki header dokumen, tabel item, atau tanda tangan apa pun.
    const emptyPanelHtml = html.slice(html.indexOf('data-empty-panel="true"'));
    expect(emptyPanelHtml).not.toContain("SALESMAN");
    expect(emptyPanelHtml).not.toContain("doc-engine-items");
    expect(emptyPanelHtml).not.toContain("PURCHASE ORDER");
    expect(emptyPanelHtml).not.toContain("INVOICE");
  });

  it("mode proof (default) tidak menampilkan label 'Panel Atas'/'Panel Bawah' -- proofMode harus eksplisit diaktifkan", () => {
    const top = invoiceViewModel("INV-20260811-000003", "Toko A");
    const bottom = invoiceViewModel("INV-20260811-000004", "Toko B");
    const [sheet] = buildPrintSheets([top, bottom]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet! }));
    expect(html).not.toContain("Panel Atas");
    expect(html).not.toContain("Panel Bawah");
    expect(html).toContain('data-proof-mode="false"');
  });

  it("proofMode=true menampilkan label 'Panel Atas'/'Panel Bawah' untuk visual proof/debug", () => {
    const top = invoiceViewModel("INV-20260811-000005", "Toko A");
    const bottom = invoiceViewModel("INV-20260811-000006", "Toko B");
    const [sheet] = buildPrintSheets([top, bottom]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet!, proofMode: true }));
    expect(html).toContain("Panel Atas");
    expect(html).toContain("Panel Bawah");
    expect(html).toContain('data-proof-mode="true"');
  });
});

describe("PhysicalPrintSheet -- E. production cleanliness (AUDIT FIX: perforasi dihapus total)", () => {
  it("sheet dengan dua panel terisi TIDAK mengandung ilustrasi perforasi/sprocket/decorative dots apa pun", () => {
    const top = invoiceViewModel("INV-20260811-000007", "Toko A");
    const bottom = poViewModel("PO-20260810-000013", "Toko B");
    const [sheet] = buildPrintSheets([top, bottom]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet! }));
    expect(html).not.toContain("doc-engine-perforation");
    expect(html).not.toContain("radial-gradient");
  });

  it("sheet dengan panel kosong TIDAK mengandung perforasi di area kosong maupun area terisi", () => {
    const only = invoiceViewModel("INV-20260811-000008", "Toko Tunggal");
    const [sheet] = buildPrintSheets([only]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheet! }));
    expect(html).not.toContain("doc-engine-perforation");
  });
});

describe("PhysicalPrintSheet -- continuation panel dalam satu sheet", () => {
  it("dokumen 25 item: sheet pertama berisi Halaman 1/3 (atas) dan 2/3 (bawah), identitas dokumen sama", () => {
    const longVm = poViewModel("PO-25ITEMS-000001", "Toko Panjang");
    const withManyLines = { ...longVm, lines: Array.from({ length: 25 }, (_, i) => ({ ...longVm.lines[0]!, no: i + 1, productCode: `SKU-${i + 1}` })) };
    const sheets = buildPrintSheets([withManyLines]);
    const html = renderToStaticMarkup(createElement(PhysicalPrintSheet, { sheet: sheets[0]! }));
    expect(html).toContain("1/3");
    expect(html).toContain("2/3");
    expect((html.match(/PO-25ITEMS-000001/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("doc-engine-perforation");
  });
});
