import { describe, expect, it } from "vitest";
import { DocumentSourceError } from "./errors";
import { resolvePurchaseOrderLines, validateInvoiceSource } from "./source-validation";
import type { DeliverySource, OrderLineSource, OrderSource } from "./types";

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

function deliveryLine(overrides: Partial<DeliverySource["lines"][number]> = {}): DeliverySource["lines"][number] {
  return {
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
    lines: [deliveryLine()],
    ...overrides,
  };
}

describe("resolvePurchaseOrderLines -- 1, 2", () => {
  it("1. PO dibangun dari baris yang benar-benar milik order (order valid)", () => {
    const o = order();
    const resolved = resolvePurchaseOrderLines(o, o.lines);
    expect(resolved).toEqual(o.lines);
  });

  it("2. PO menolak order line dari order lain", () => {
    const orderA = order({ orderId: "order-A", lines: [orderLine({ orderLineId: "line-A1" })] });
    const orderBForeignLine = orderLine({ orderLineId: "line-B1" }); // milik order B, bukan A

    expect(() => resolvePurchaseOrderLines(orderA, [orderBForeignLine])).toThrow(DocumentSourceError);
    try {
      resolvePurchaseOrderLines(orderA, [orderBForeignLine]);
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("ORDER_LINE_FOREIGN");
    }
  });

  it("PO tanpa item sama sekali ditolak (ORDER_LINE_EMPTY)", () => {
    const o = order();
    expect(() => resolvePurchaseOrderLines(o, [])).toThrow(DocumentSourceError);
  });

  it("baris kanonik dipakai (bukan objek kandidat mentah) -- mencegah nilai disuntik", () => {
    const o = order({ lines: [orderLine({ orderLineId: "line-1", unitPrice: 85000 })] });
    const tamperedCandidate = orderLine({ orderLineId: "line-1", unitPrice: 1 }); // harga dipalsukan
    const resolved = resolvePurchaseOrderLines(o, [tamperedCandidate]);
    expect(resolved[0]!.unitPrice).toBe(85000); // tetap harga order asli, bukan 1
  });
});

describe("validateInvoiceSource -- 3, 4, 5, 6", () => {
  it("3. Invoice menerima order dan delivery yang terhubung benar", () => {
    expect(() => validateInvoiceSource(order(), delivery())).not.toThrow();
  });

  it("4. Invoice menolak delivery dengan order_id berbeda", () => {
    const mismatched = delivery({ orderId: "order-OTHER" });
    try {
      validateInvoiceSource(order(), mismatched);
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DELIVERY_ORDER_MISMATCH");
    }
  });

  it("5. Invoice menolak company_id berbeda", () => {
    const crossTenant = delivery({ companyId: "company-OTHER" });
    try {
      validateInvoiceSource(order(), crossTenant);
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("COMPANY_MISMATCH");
    }
  });

  it("6. Invoice menolak delivery line yang merujuk order line dari order lain", () => {
    const foreignDeliveryLine = deliveryLine({ orderLineId: "line-FROM-OTHER-ORDER" });
    const d = delivery({ lines: [foreignDeliveryLine] });
    try {
      validateInvoiceSource(order(), d);
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DELIVERY_LINE_FOREIGN");
    }
  });

  it("delivery yang belum mencapai status sah untuk ditagih ditolak (DELIVERY_NOT_BILLABLE)", () => {
    const notYetEligible = delivery({ billingStatus: "NOT_YET_ELIGIBLE" });
    try {
      validateInvoiceSource(order(), notYetEligible);
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DELIVERY_NOT_BILLABLE");
    }
  });
});
