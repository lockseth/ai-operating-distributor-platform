import { describe, expect, it } from "vitest";
import { buildInvoiceSnapshot } from "./invoice-builder";
import { buildPrintViewModel } from "./print-view-model";
import { formatRupiah as formatRupiahForTest } from "./monetary";
import type { DeliverySource, OrderLineSource, OrderSource, TenantIdentity } from "./types";

const TENANT: TenantIdentity = {
  companyId: "company-1",
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
    companyId: "company-1",
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
    companyId: "company-1",
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

describe("buildPrintViewModel -- SATU view model per snapshot (LOCKED 2026-07-23: 1 dokumen = 1 halaman, TIDAK ADA duplikasi panel)", () => {
  it("10. nomor dokumen dipetakan apa adanya dari snapshot", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000001",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.documentNumber).toBe("INV-20260811-000001");
  });

  it("17. total dan diskon dipetakan apa adanya (terformat Rupiah) dari snapshot", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000002",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.grandTotalLabel).toBe(formatRupiahForTest(snapshot.totals.grandTotal));
    expect(vm.totalDiscountLabel).toBe(formatRupiahForTest(snapshot.totals.totalDiscount));
    expect(vm.subtotalLabel).toBe(formatRupiahForTest(snapshot.totals.subtotal));
  });

  it("view model TIDAK memiliki struktur 'panels' -- satu objek flat, bukan array dua elemen (supersede 2-panel LOCK lama)", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000003",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm).not.toHaveProperty("panels");
    expect(Array.isArray(vm)).toBe(false);
  });

  it("formatRupiah dipakai di view model, bukan angka mentah tak terformat", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000004",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.grandTotalLabel).toMatch(/^Rp[\d.]+$/);
  });

  it("LOCKED: terbilangLabel dihitung dari grandTotal, selalu diakhiri 'Rupiah', dan tidak pernah menyebut DPP/PPN", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000005",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.terbilangLabel.endsWith("Rupiah")).toBe(true);
    expect(vm.terbilangLabel.toUpperCase()).not.toContain("PPN");
    expect(vm.terbilangLabel.toUpperCase()).not.toContain("DPP");
  });

  it("documentDateLabel diformat Bahasa Indonesia (bukan ISO mentah)", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000006",
      documentDate: "2026-07-15",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.documentDateLabel).toBe("15 Juli 2026");
  });

  it("dueDateLabel dihitung dari documentDate + paymentTermsDays ('Tempo')", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order({ paymentTermsDays: 14 }),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000007",
      documentDate: "2026-07-15",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.dueDateLabel).toBe("29 Juli 2026 (14 Hari)");
  });

  it("storeCode/storePhone dipetakan apa adanya dari StoreIdentity", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000008",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.storeCode).toBe("CUST-1");
    expect(vm.storePhone).toBe("081200000001");
  });

  it("receiverName berasal dari store.picName -- null bila belum ditentukan (bukan nama karangan)", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order({ store: { customerId: "cust-1", storeCode: "CUST-1", storeName: "Toko Sari", storeAddress: "Jl. Mangga 1", storePhone: "081200000001", picName: null } }),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000009",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.receiverName).toBeNull();
  });

  it("paymentTermsLabel null bila paymentTermsDays null (renderer menyembunyikan baris, bukan placeholder)", () => {
    // Catatan: skenario ini secara bisnis seharusnya sudah ditolak PAYMENT_TERMS_INCOMPLETE
    // sebelum sampai builder (lihat repository-adapter.ts assertPaymentTermsComplete) --
    // test ini membuktikan view model tetap null-safe di lapisan presentasi.
    const snapshot = buildInvoiceSnapshot({
      order: order({ paymentTermsDays: null }),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000010",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.paymentTermsLabel).toBeNull();
    expect(vm.dueDateLabel).toBeNull();
  });
});
