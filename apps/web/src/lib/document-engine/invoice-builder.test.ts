import { describe, expect, it } from "vitest";
import { DocumentSourceError } from "./errors";
import { buildInvoiceSnapshot } from "./invoice-builder";
import { MAX_DOCUMENT_LINE_ITEMS } from "./source-validation";
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

describe("buildInvoiceSnapshot -- 3, 4, 5, 6", () => {
  it("3. Invoice menerima order dan delivery yang terhubung benar", () => {
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: delivery(),
      tenant: TENANT,
      documentNumber: "INV-20260811-000001",
      documentDate: "2026-08-11",
    });
    expect(snapshot.documentType).toBe("INVOICE");
    expect(snapshot.orderReference).toBe("SO-0001");
    expect(snapshot.deliveryReference).toBe("DO-0001");
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]!.quantity).toBe(10);
  });

  it("4. Invoice menolak delivery dengan order_id berbeda", () => {
    expect(() =>
      buildInvoiceSnapshot({
        order: order(),
        delivery: delivery({ orderId: "order-OTHER" }),
        tenant: TENANT,
        documentNumber: "INV-20260811-000002",
        documentDate: "2026-08-11",
      }),
    ).toThrow(DocumentSourceError);
  });

  it("5. Invoice menolak company_id berbeda", () => {
    expect(() =>
      buildInvoiceSnapshot({
        order: order(),
        delivery: delivery({ companyId: "company-OTHER" }),
        tenant: TENANT,
        documentNumber: "INV-20260811-000003",
        documentDate: "2026-08-11",
      }),
    ).toThrow(DocumentSourceError);
  });

  it("6. Invoice menolak delivery line dari order lain", () => {
    expect(() =>
      buildInvoiceSnapshot({
        order: order(),
        delivery: delivery({ lines: [deliveryLine({ orderLineId: "line-FROM-OTHER-ORDER" })] }),
        tenant: TENANT,
        documentNumber: "INV-20260811-000004",
        documentDate: "2026-08-11",
      }),
    ).toThrow(DocumentSourceError);
  });
});

describe("buildInvoiceSnapshot -- 7, 8, 9 (partial delivery & quantity invariant)", () => {
  it("7. Partial delivery menghasilkan Invoice berdasarkan verified quantity, BUKAN ordered quantity", () => {
    const partial = delivery({ lines: [deliveryLine({ orderedQuantity: 10, verifiedQuantity: 6, discountAmount: 3000 })] });
    const snapshot = buildInvoiceSnapshot({
      order: order(),
      delivery: partial,
      tenant: TENANT,
      documentNumber: "INV-20260811-000005",
      documentDate: "2026-08-11",
    });
    expect(snapshot.lines[0]!.quantity).toBe(6);
    expect(snapshot.lines[0]!.quantity).not.toBe(10);
    expect(snapshot.lines[0]!.lineTotal).toBe(6 * 85000 - 3000);
  });

  it("8. Invoice menolak qty override melebihi verified/accepted quantity", () => {
    const partial = delivery({ lines: [deliveryLine({ verifiedQuantity: 6 })] });
    expect(() =>
      buildInvoiceSnapshot({
        order: order(),
        delivery: partial,
        tenant: TENANT,
        documentNumber: "INV-20260811-000006",
        documentDate: "2026-08-11",
        quantityOverrides: [{ orderLineId: "line-1", invoicedQuantity: 8 }], // > verifiedQuantity (6)
      }),
    ).toThrow(DocumentSourceError);
  });

  it("9. Undelivered/rejected quantity (verifiedQuantity=0) tidak masuk Invoice", () => {
    const mixed = delivery({
      lines: [
        deliveryLine({ deliveryLineId: "dline-1", orderLineId: "line-1", verifiedQuantity: 4 }),
        deliveryLine({ deliveryLineId: "dline-2", orderLineId: "line-2", productName: "Ditolak Toko", verifiedQuantity: 0 }),
      ],
    });
    const o = order({
      lines: [
        orderLine({ orderLineId: "line-1" }),
        orderLine({ orderLineId: "line-2", productName: "Ditolak Toko" }),
      ],
    });
    const snapshot = buildInvoiceSnapshot({
      order: o,
      delivery: mixed,
      tenant: TENANT,
      documentNumber: "INV-20260811-000007",
      documentDate: "2026-08-11",
    });
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines.some((l) => l.productName === "Ditolak Toko")).toBe(false);
  });

  it("seluruh baris verifiedQuantity 0 -> NO_BILLABLE_LINES", () => {
    const emptyDelivery = delivery({ lines: [deliveryLine({ verifiedQuantity: 0 })] });
    try {
      buildInvoiceSnapshot({
        order: order(),
        delivery: emptyDelivery,
        tenant: TENANT,
        documentNumber: "INV-20260811-000008",
        documentDate: "2026-08-11",
      });
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("NO_BILLABLE_LINES");
    }
  });

  it("delivery belum eligible untuk ditagih -> builder gagal dengan domain error jelas", () => {
    const notYetEligible = delivery({ billingStatus: "NOT_YET_ELIGIBLE" });
    try {
      buildInvoiceSnapshot({
        order: order(),
        delivery: notYetEligible,
        tenant: TENANT,
        documentNumber: "INV-20260811-000009",
        documentDate: "2026-08-11",
      });
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DELIVERY_NOT_BILLABLE");
    }
  });
});

describe("buildInvoiceSnapshot -- kapasitas cetak LOCKED, disatukan dengan MAX_ITEM_ROWS_PER_PANEL (print-capacity.ts)", () => {
  function sourcesWithLineCount(count: number): { order: OrderSource; delivery: DeliverySource } {
    const orderLines = Array.from({ length: count }, (_, i) =>
      orderLine({ orderLineId: `line-${i + 1}`, productCode: `SKU-${i + 1}` }),
    );
    const deliveryLines = Array.from({ length: count }, (_, i) =>
      deliveryLine({ deliveryLineId: `dline-${i + 1}`, orderLineId: `line-${i + 1}`, productCode: `SKU-${i + 1}` }),
    );
    return { order: order({ lines: orderLines }), delivery: delivery({ lines: deliveryLines }) };
  }

  it("tepat batas maksimum baris item tertagih -- PASS, snapshot berhasil dibangun", () => {
    const { order: o, delivery: d } = sourcesWithLineCount(MAX_DOCUMENT_LINE_ITEMS);
    const snapshot = buildInvoiceSnapshot({
      order: o,
      delivery: d,
      tenant: TENANT,
      documentNumber: "INV-20260811-000010",
      documentDate: "2026-08-11",
    });
    expect(snapshot.lines).toHaveLength(MAX_DOCUMENT_LINE_ITEMS);
  });

  it("satu baris melebihi batas maksimum tertagih -- REJECT eksplisit DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED, bukan halaman lanjutan", () => {
    const overLimit = MAX_DOCUMENT_LINE_ITEMS + 1;
    const { order: o, delivery: d } = sourcesWithLineCount(overLimit);
    try {
      buildInvoiceSnapshot({
        order: o,
        delivery: d,
        tenant: TENANT,
        documentNumber: "INV-20260811-000011",
        documentDate: "2026-08-11",
      });
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED");
      expect((err as DocumentSourceError).metadata).toEqual({ actualCount: overLimit, maxCount: MAX_DOCUMENT_LINE_ITEMS });
    }
  });

  it("baris sumber melebihi batas tapi 1 verifiedQuantity=0 -> tertagih tepat pada batas -- PASS (limit dihitung dari baris AKHIR, bukan baris sumber mentah)", () => {
    const overLimit = MAX_DOCUMENT_LINE_ITEMS + 1;
    const { order: o, delivery: d } = sourcesWithLineCount(overLimit);
    d.lines[overLimit - 1] = { ...d.lines[overLimit - 1]!, verifiedQuantity: 0 };
    const snapshot = buildInvoiceSnapshot({
      order: o,
      delivery: d,
      tenant: TENANT,
      documentNumber: "INV-20260811-000012",
      documentDate: "2026-08-11",
    });
    expect(snapshot.lines).toHaveLength(MAX_DOCUMENT_LINE_ITEMS);
  });
});
