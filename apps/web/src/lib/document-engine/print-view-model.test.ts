import { describe, expect, it } from "vitest";
import { buildInvoiceSnapshot } from "./invoice-builder";
import { buildPrintViewModel } from "./print-view-model";
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

describe("buildPrintViewModel -- 10, 17 (dua panel dari snapshot yang sama)", () => {
  it("10. nomor dokumen kedua panel identik", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000001",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.panels[0].documentNumber).toBe(vm.panels[1].documentNumber);
    expect(vm.panels[0].documentNumber).toBe("INV-20260811-000001");
  });

  it("17. total dan diskon kedua panel identik", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000002",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.panels[0].grandTotalLabel).toBe(vm.panels[1].grandTotalLabel);
    expect(vm.panels[0].totalDiscountLabel).toBe(vm.panels[1].totalDiscountLabel);
    expect(vm.panels[0].subtotalLabel).toBe(vm.panels[1].subtotalLabel);
  });

  it("kedua panel adalah referensi objek yang SAMA (bukan dua build terpisah)", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000003",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.panels[0]).toBe(vm.panels[1]);
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
    expect(vm.panels[0].grandTotalLabel).toMatch(/^Rp[\d.]+$/);
  });

  it("LOCKED: terbilangLabel dihitung dari grandTotal yang sama, identik di kedua panel, dan tidak pernah menyebut DPP/PPN", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000005",
      documentDate: "2026-08-11",
    });
    const vm = buildPrintViewModel(snapshot);
    expect(vm.panels[0].terbilangLabel).toBe(vm.panels[1].terbilangLabel);
    expect(vm.panels[0].terbilangLabel.endsWith("Rupiah")).toBe(true);
    expect(vm.panels[0].terbilangLabel.toUpperCase()).not.toContain("PPN");
    expect(vm.panels[0].terbilangLabel.toUpperCase()).not.toContain("DPP");
  });
});
