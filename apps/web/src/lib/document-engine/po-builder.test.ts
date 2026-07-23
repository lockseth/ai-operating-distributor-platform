import { describe, expect, it } from "vitest";
import { DocumentSourceError } from "./errors";
import { buildPurchaseOrderSnapshot } from "./po-builder";
import { MAX_DOCUMENT_LINE_ITEMS } from "./source-validation";
import type { OrderLineSource, OrderSource, TenantIdentity } from "./types";

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

describe("buildPurchaseOrderSnapshot -- 1", () => {
  it("1. PO dibangun dari satu order yang valid -- total dihitung dari domain calculation, bukan view layer", () => {
    const o = order();
    const snapshot = buildPurchaseOrderSnapshot({
      order: o,
      tenant: TENANT,
      documentNumber: "PO-20260810-000001",
      documentDate: "2026-08-10",
      now: () => new Date("2026-08-10T03:00:00Z"),
    });

    expect(snapshot.documentType).toBe("PURCHASE_ORDER");
    expect(snapshot.orderReference).toBe("SO-0001");
    expect(snapshot.deliveryReference).toBeNull();
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0]!.lineTotal).toBe(10 * 85000 - 5000);
    expect(snapshot.totals.grandTotal).toBe(10 * 85000 - 5000);
    expect(snapshot.signatures.salesmanName).toBe("Budi");
    expect(snapshot.signatures.delivererName).toBe("Budi"); // default: salesman merangkap pengirim
  });

  it("PO dengan banyak baris -- nomor urut & total agregat benar", () => {
    const o = order({
      lines: [
        orderLine({ orderLineId: "line-1", quantity: 5, unitPrice: 10000, discountAmount: 0 }),
        orderLine({ orderLineId: "line-2", quantity: 2, unitPrice: 20000, discountAmount: 1000 }),
      ],
    });
    const snapshot = buildPurchaseOrderSnapshot({
      order: o,
      tenant: TENANT,
      documentNumber: "PO-20260810-000002",
      documentDate: "2026-08-10",
    });
    expect(snapshot.lines.map((l) => l.no)).toEqual([1, 2]);
    expect(snapshot.totals.subtotal).toBe(5 * 10000 + 2 * 20000);
    expect(snapshot.totals.totalDiscount).toBe(1000);
  });

  it("2. PO menolak order line dari order lain (via builder, bukan hanya validator langsung)", () => {
    const o = order({ orderId: "order-A", lines: [orderLine({ orderLineId: "line-A1" })] });
    const foreignLine = orderLine({ orderLineId: "line-FROM-ORDER-B" });

    expect(() =>
      buildPurchaseOrderSnapshot({
        order: o,
        tenant: TENANT,
        documentNumber: "PO-20260810-000003",
        documentDate: "2026-08-10",
        lines: [foreignLine],
      }),
    ).toThrow(DocumentSourceError);
  });
});

describe("buildPurchaseOrderSnapshot -- kapasitas cetak LOCKED, disatukan dengan MAX_ITEM_ROWS_PER_PANEL (print-capacity.ts)", () => {
  function ordersWithLineCount(count: number): OrderSource {
    return order({
      lines: Array.from({ length: count }, (_, i) =>
        orderLine({ orderLineId: `line-${i + 1}`, productCode: `SKU-${i + 1}` }),
      ),
    });
  }

  it("tepat batas maksimum baris item -- PASS, snapshot berhasil dibangun", () => {
    const snapshot = buildPurchaseOrderSnapshot({
      order: ordersWithLineCount(MAX_DOCUMENT_LINE_ITEMS),
      tenant: TENANT,
      documentNumber: "PO-20260810-000004",
      documentDate: "2026-08-10",
    });
    expect(snapshot.lines).toHaveLength(MAX_DOCUMENT_LINE_ITEMS);
  });

  it("satu baris melebihi batas maksimum -- REJECT eksplisit DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED, bukan halaman lanjutan", () => {
    const overLimit = MAX_DOCUMENT_LINE_ITEMS + 1;
    try {
      buildPurchaseOrderSnapshot({
        order: ordersWithLineCount(overLimit),
        tenant: TENANT,
        documentNumber: "PO-20260810-000005",
        documentDate: "2026-08-10",
      });
      expect.fail("seharusnya throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED");
      expect((err as DocumentSourceError).metadata).toEqual({ actualCount: overLimit, maxCount: MAX_DOCUMENT_LINE_ITEMS });
    }
  });
});
