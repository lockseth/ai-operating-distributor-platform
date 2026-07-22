// =============================================================================
// Live repository adapter -- test dengan FAKE reader bertipe (BUKAN Supabase
// cloud), sesuai gate: "adapter harus bisa diuji tanpa database cloud". Fake
// reader mengimplementasikan interface OrderReader/DeliveryReader yang SAMA
// dengan yang dipakai reader produksi (ConfirmedOrderReader/
// DeliveryVerificationReader) -- membuktikan logika pemetaan/orkestrasi benar
// terlepas dari implementasi I/O di baliknya.
// =============================================================================

import { describe, expect, it } from "vitest";
import { buildInvoiceSnapshot } from "./invoice-builder";
import { buildPurchaseOrderSnapshot } from "./po-builder";
import { buildPrintViewModel } from "./print-view-model";
import { DocumentSourceError } from "./errors";
import {
  ConfirmedOrderReader,
  DeliveryVerificationReader,
  loadInvoiceSource,
  loadPurchaseOrderSource,
  type DeliveryReader,
  type DeliveryReaderLine,
  type DeliveryReaderRecord,
  type OrderReader,
  type OrderReaderLine,
  type OrderReaderRecord,
} from "./repository-adapter";
import type { TenantIdentity } from "./types";
import type { DeliveryRepositoryInterface, ConfirmedOrderSnapshot } from "@/lib/delivery/repository";
import type { DeliveryRecord, DeliveryStatus } from "@/lib/delivery/types";

const TENANT: TenantIdentity = {
  companyId: "company-swa",
  companyName: "PT SUMBER WARNA ALAM SUDIADA",
  companyAddress: "Jl. Cendana Raya Talun Cirebon 45171",
  companyEmail: "sumberwanaalamsudiada@gmail.com",
  companyPhone: "085185905859",
  logoUrl: null,
};

// ---------------------------------------------------------------------------
// Fixtures -- OrderReaderRecord/DeliveryReaderRecord LENGKAP (semua field
// terisi) supaya jalur bahagia bisa dibuktikan; test ketidaklengkapan
// memakai override eksplisit per field.
// ---------------------------------------------------------------------------

function orderReaderLine(overrides: Partial<OrderReaderLine> = {}): OrderReaderLine {
  return {
    orderLineId: "soi-1",
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

function orderReaderRecord(overrides: Partial<OrderReaderRecord> = {}): OrderReaderRecord {
  return {
    orderId: "order-A",
    companyId: "company-swa",
    orderNumber: "SO-0001",
    orderDate: "2026-08-10",
    customerId: "cust-1",
    customerName: "Toko Sari",
    customerAddress: "Jl. Mangga 1",
    picName: "Ibu Sari",
    salesmanId: "sales-1",
    salesmanName: "Budi",
    paymentTermsDays: 14,
    lines: [orderReaderLine()],
    ...overrides,
  };
}

function deliveryReaderLine(overrides: Partial<DeliveryReaderLine> = {}): DeliveryReaderLine {
  return {
    deliveryLineId: "dli-1",
    orderLineId: "soi-1",
    productCode: "SKU-1",
    productName: "Indomie Goreng",
    productType: "Mie Instan",
    unit: "dus",
    orderedQuantity: 10,
    verifiedQuantity: 10,
    unitPrice: 85000,
    ...overrides,
  };
}

function deliveryReaderRecord(overrides: Partial<DeliveryReaderRecord> = {}): DeliveryReaderRecord {
  return {
    deliveryId: "delivery-A",
    companyId: "company-swa",
    orderId: "order-A",
    deliveryNumber: "DO-0001",
    deliveryDate: "2026-08-11",
    billingStatus: "ELIGIBLE",
    lines: [deliveryReaderLine()],
    ...overrides,
  };
}

/** Reader realistis: menyaring company_id di sisi implementasi (seperti reader produksi). */
function makeOrderReader(records: OrderReaderRecord[]): OrderReader {
  return {
    async getOrderForDocument(companyId, orderId) {
      const record = records.find((r) => r.orderId === orderId);
      if (!record) return null;
      if (record.companyId !== companyId) return null;
      return record;
    },
  };
}

/** Reader "bocor" -- SENGAJA tidak menyaring company_id, dipakai untuk menguji defense-in-depth orkestrasi. */
function makeLeakyOrderReader(records: OrderReaderRecord[]): OrderReader {
  return {
    async getOrderForDocument(_companyId, orderId) {
      return records.find((r) => r.orderId === orderId) ?? null;
    },
  };
}

function makeDeliveryReader(records: DeliveryReaderRecord[]): DeliveryReader {
  return {
    async getDeliveryForDocument(companyId, deliveryId) {
      const record = records.find((r) => r.deliveryId === deliveryId);
      if (!record) return null;
      if (record.companyId !== companyId) return null;
      return record;
    },
  };
}

function makeLeakyDeliveryReader(records: DeliveryReaderRecord[]): DeliveryReader {
  return {
    async getDeliveryForDocument(_companyId, deliveryId) {
      return records.find((r) => r.deliveryId === deliveryId) ?? null;
    },
  };
}

describe("loadPurchaseOrderSource -- pemetaan Order dasar", () => {
  it("1. orderId otomatis dari record repository", async () => {
    const reader = makeOrderReader([orderReaderRecord()]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.orderId).toBe("order-A");
  });

  it("2. customerId otomatis dari order yang sama", async () => {
    const reader = makeOrderReader([orderReaderRecord({ customerId: "cust-99" })]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.store.customerId).toBe("cust-99");
  });

  it("3. Caller tidak bisa mengganti orderId lewat nomor bisnis palsu -- hanya UUID/id asli yang dikenali reader", async () => {
    const reader = makeOrderReader([orderReaderRecord()]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "SWAS-ORD-202608-000001" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("4. Caller tidak bisa override customerId/customerCode manual -- loadPurchaseOrderSource hanya menerima {companyId, orderId}", async () => {
    const reader = makeOrderReader([orderReaderRecord({ customerId: "cust-1" })]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    // Tidak ada parameter lain pada params -- hasil SELALU dari record repository.
    expect(order.store.customerId).toBe("cust-1");
  });

  it("5. orderNumber dipetakan dari nomor bisnis order yang sudah persist", async () => {
    const reader = makeOrderReader([orderReaderRecord({ orderNumber: "SO-2026-0042" })]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.orderNumber).toBe("SO-2026-0042");
  });

  it("7. UUID internal orderId TIDAK PERNAH diubah menjadi string berprefix SWAS", async () => {
    const reader = makeOrderReader([orderReaderRecord({ orderId: "11111111-2222-3333-4444-555555555555" })]);
    const order = await loadPurchaseOrderSource(reader, {
      companyId: "company-swa",
      orderId: "11111111-2222-3333-4444-555555555555",
    });
    expect(order.orderId).toBe("11111111-2222-3333-4444-555555555555");
    expect(order.orderId).not.toMatch(/^SWAS-/);
  });

  it("9. Order valid dipetakan penuh ke OrderSource", async () => {
    const reader = makeOrderReader([orderReaderRecord()]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order).toEqual({
      orderId: "order-A",
      companyId: "company-swa",
      orderNumber: "SO-0001",
      orderDate: "2026-08-10",
      store: { customerId: "cust-1", storeName: "Toko Sari", storeAddress: "Jl. Mangga 1", picName: "Ibu Sari" },
      salesman: { salesmanId: "sales-1", salesmanName: "Budi" },
      lines: [
        {
          orderLineId: "soi-1",
          productCode: "SKU-1",
          productName: "Indomie Goreng",
          productType: "Mie Instan",
          unit: "dus",
          quantity: 10,
          unitPrice: 85000,
          discountAmount: 5000,
        },
      ],
      paymentTermsDays: 14,
    });
  });

  it("10. Harga (unitPrice) berasal dari priced order snapshot, bukan harga produk saat ini", async () => {
    const reader = makeOrderReader([orderReaderRecord({ lines: [orderReaderLine({ unitPrice: 77000 })] })]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.lines[0].unitPrice).toBe(77000);
  });

  it("11. Diskon berasal dari order line snapshot", async () => {
    const reader = makeOrderReader([orderReaderRecord({ lines: [orderReaderLine({ discountAmount: 12345 })] })]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.lines[0].discountAmount).toBe(12345);
  });

  it("12. OrderReader tidak memiliki kapabilitas untuk meminta harga produk saat ini (hanya satu operasi baca per order)", () => {
    const reader = makeOrderReader([orderReaderRecord()]);
    // OrderReader interface HANYA punya getOrderForDocument -- tidak ada
    // getCurrentProductPrice/getProductMaster dsb pada kontraknya.
    expect(Object.keys(reader)).toEqual(["getOrderForDocument"]);
  });

  it("13. Adapter tidak meminta data customer/PIC tambahan -- seluruh field toko berasal dari satu panggilan reader yang sama", async () => {
    let callCount = 0;
    const reader: OrderReader = {
      async getOrderForDocument() {
        callCount += 1;
        return orderReaderRecord();
      },
    };
    await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(callCount).toBe(1);
  });

  it("14. Field opsional (productType/picName) yang belum tersedia TIDAK diisi data dummy -- tetap null", async () => {
    const reader = makeOrderReader([
      orderReaderRecord({
        picName: null,
        customerAddress: null,
        lines: [orderReaderLine({ productType: null, productCode: null })],
      }),
    ]);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.store.picName).toBeNull();
    expect(order.store.storeAddress).toBeNull();
    expect(order.lines[0].productType).toBeNull();
    expect(order.lines[0].productCode).toBeNull();
  });

  it("15a. order.companyId berbeda dari authenticated tenant (reader menyaring dengan benar) -> ORDER_NOT_FOUND", async () => {
    const reader = makeOrderReader([orderReaderRecord({ companyId: "company-other" })]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("15b. order.companyId berbeda dari authenticated tenant (reader BOCOR, tidak menyaring) -> tetap ditolak TENANT_CONTEXT_MISMATCH (defense-in-depth)", async () => {
    const reader = makeLeakyOrderReader([orderReaderRecord({ companyId: "company-other" })]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" }),
    ).rejects.toMatchObject({ code: "TENANT_CONTEXT_MISMATCH" });
  });

  it("16. Order tidak ditemukan -> domain error aman, pesan tidak membocorkan data tenant lain", async () => {
    const reader = makeOrderReader([]);
    try {
      await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-ghost" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("ORDER_NOT_FOUND");
      expect((err as Error).message).not.toContain("company-other");
      expect((err as Error).message).not.toMatch(/company_id|companyId=/i);
    }
  });

  it("8a. orderDate belum tersedia -> ORDER_SOURCE_INCOMPLETE eksplisit, BUKAN nomor/tanggal sementara", async () => {
    const reader = makeOrderReader([orderReaderRecord({ orderDate: null })]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" }),
    ).rejects.toMatchObject({ code: "ORDER_SOURCE_INCOMPLETE" });
  });

  it("8b. salesman belum tersedia -> ORDER_SOURCE_INCOMPLETE, pesan menyebut field yang hilang", async () => {
    const reader = makeOrderReader([orderReaderRecord({ salesmanId: null, salesmanName: null })]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" }),
    ).rejects.toMatchObject({
      code: "ORDER_SOURCE_INCOMPLETE",
    });
    try {
      await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("salesman");
    }
  });

  it("8c. discountAmount baris order belum tersedia (null) -> ORDER_SOURCE_INCOMPLETE, TIDAK dianggap 0", async () => {
    const reader = makeOrderReader([orderReaderRecord({ lines: [orderReaderLine({ discountAmount: null })] })]);
    await expect(
      loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" }),
    ).rejects.toMatchObject({ code: "ORDER_SOURCE_INCOMPLETE" });
  });

  it("28a. Error repository tidak pernah menjadi dokumen kosong -- error dari reader diteruskan apa adanya", async () => {
    const reader: OrderReader = {
      async getOrderForDocument() {
        throw new Error("connection reset");
      },
    };
    await expect(loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" })).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("loadInvoiceSource -- pemetaan Order + Delivery", () => {
  it("6. deliveryNumber dipetakan dari nomor bisnis delivery yang sudah persist", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ deliveryNumber: "DO-2026-0007" })]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    expect(bundle.delivery.deliveryNumber).toBe("DO-2026-0007");
  });

  it("17. Delivery valid dipetakan penuh ke DeliverySource", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord()]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    expect(bundle.delivery).toEqual({
      deliveryId: "delivery-A",
      companyId: "company-swa",
      orderId: "order-A",
      deliveryNumber: "DO-0001",
      deliveryDate: "2026-08-11",
      billingStatus: "ELIGIBLE",
      lines: [
        {
          deliveryLineId: "dli-1",
          orderLineId: "soi-1",
          productCode: "SKU-1",
          productName: "Indomie Goreng",
          productType: "Mie Instan",
          unit: "dus",
          orderedQuantity: 10,
          verifiedQuantity: 10,
          unitPrice: 85000,
          discountAmount: 5000, // prorata penuh: verifiedQuantity === orderedQuantity
        },
      ],
    });
  });

  it("18a. delivery.companyId berbeda (reader menyaring benar) -> DELIVERY_NOT_FOUND", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ companyId: "company-other" })]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_FOUND" });
  });

  it("18b. delivery.companyId berbeda (reader BOCOR) -> tetap ditolak TENANT_CONTEXT_MISMATCH (defense-in-depth)", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeLeakyDeliveryReader([deliveryReaderRecord({ companyId: "company-other" })]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
      ),
    ).rejects.toMatchObject({ code: "TENANT_CONTEXT_MISMATCH" });
  });

  it("19. delivery.orderId berbeda dari order -> DELIVERY_ORDER_MISMATCH", async () => {
    const orderReader = makeOrderReader([orderReaderRecord({ orderId: "order-A" })]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ orderId: "order-B" })]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_ORDER_MISMATCH" });
  });

  it("20. Delivery line asing (orderLineId tidak ada di order) ditolak oleh adapter -> DELIVERY_LINE_FOREIGN", async () => {
    const orderReader = makeOrderReader([orderReaderRecord({ lines: [orderReaderLine({ orderLineId: "soi-1" })] })]);
    const deliveryReader = makeDeliveryReader([
      deliveryReaderRecord({ lines: [deliveryReaderLine({ orderLineId: "soi-FOREIGN" })] }),
    ]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_LINE_FOREIGN" });
  });

  it("21+22. verifiedQuantity dipakai sebagai kuantitas invoice, orderedQuantity TIDAK dipakai sebagai fallback", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([
      deliveryReaderRecord({ lines: [deliveryReaderLine({ orderedQuantity: 10, verifiedQuantity: 6 })] }),
    ]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    const snapshot = buildInvoiceSnapshot({
      order: bundle.order,
      delivery: bundle.delivery,
      tenant: TENANT,
      documentNumber: "INV-TEST-1",
      documentDate: "2026-08-12",
    });
    expect(snapshot.lines[0].quantity).toBe(6);
    expect(snapshot.lines[0].quantity).not.toBe(10);
  });

  it("23. Shipped-but-not-verified (verifiedQuantity 0) tidak masuk baris invoice", async () => {
    const orderReader = makeOrderReader([
      orderReaderRecord({
        lines: [orderReaderLine({ orderLineId: "soi-1" }), orderReaderLine({ orderLineId: "soi-2", productName: "Kecap Manis" })],
      }),
    ]);
    const deliveryReader = makeDeliveryReader([
      deliveryReaderRecord({
        lines: [
          deliveryReaderLine({ orderLineId: "soi-1", verifiedQuantity: 10 }),
          deliveryReaderLine({ deliveryLineId: "dli-2", orderLineId: "soi-2", productName: "Kecap Manis", verifiedQuantity: 0 }),
        ],
      }),
    ]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    const snapshot = buildInvoiceSnapshot({
      order: bundle.order,
      delivery: bundle.delivery,
      tenant: TENANT,
      documentNumber: "INV-TEST-2",
      documentDate: "2026-08-12",
    });
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.lines[0].productName).toBe("Indomie Goreng");
  });

  it("24. Rejected/cancelled/undelivered quantity (verifiedQuantity 0) tidak ditagih", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([
      deliveryReaderRecord({ lines: [deliveryReaderLine({ verifiedQuantity: 0 })] }),
    ]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    expect(() =>
      buildInvoiceSnapshot({
        order: bundle.order,
        delivery: bundle.delivery,
        tenant: TENANT,
        documentNumber: "INV-TEST-3",
        documentDate: "2026-08-12",
      }),
    ).toThrow(/NO_BILLABLE_LINES|Tidak ada baris/);
  });

  it("25. Partial delivery menghasilkan Invoice sebagian dengan diskon terprorata", async () => {
    const orderReader = makeOrderReader([
      orderReaderRecord({ lines: [orderReaderLine({ quantity: 10, unitPrice: 85000, discountAmount: 10000 })] }),
    ]);
    const deliveryReader = makeDeliveryReader([
      deliveryReaderRecord({ lines: [deliveryReaderLine({ orderedQuantity: 10, verifiedQuantity: 4 })] }),
    ]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    // Diskon diprorata: 10000 * 4/10 = 4000.
    expect(bundle.delivery.lines[0].discountAmount).toBe(4000);
    const snapshot = buildInvoiceSnapshot({
      order: bundle.order,
      delivery: bundle.delivery,
      tenant: TENANT,
      documentNumber: "INV-TEST-4",
      documentDate: "2026-08-12",
    });
    expect(snapshot.lines[0].quantity).toBe(4);
    expect(snapshot.totals.grandTotal).toBe(4 * 85000 - 4000);
  });

  it("26. Delivery belum ELIGIBLE -> ditolak (DELIVERY_NOT_BILLABLE lewat builder)", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ billingStatus: "NOT_YET_ELIGIBLE" })]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    expect(() =>
      buildInvoiceSnapshot({
        order: bundle.order,
        delivery: bundle.delivery,
        tenant: TENANT,
        documentNumber: "INV-TEST-5",
        documentDate: "2026-08-12",
      }),
    ).toThrow(/DELIVERY_NOT_BILLABLE|belum mencapai status/);
  });

  it("27. Delivery tidak ditemukan -> domain error aman", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-ghost" },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_FOUND" });
  });

  it("8d. deliveryNumber/deliveryDate belum tersedia -> DELIVERY_SOURCE_INCOMPLETE, BUKAN nomor sementara", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ deliveryNumber: null, deliveryDate: null })]);
    await expect(
      loadInvoiceSource(
        { orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_SOURCE_INCOMPLETE" });
  });

  it("28b. Order dan delivery TIDAK dibaca ulang untuk panel cetak kedua -- satu pemanggilan reader per entitas", async () => {
    let orderCalls = 0;
    let deliveryCalls = 0;
    const orderReader: OrderReader = {
      async getOrderForDocument() {
        orderCalls += 1;
        return orderReaderRecord();
      },
    };
    const deliveryReader: DeliveryReader = {
      async getDeliveryForDocument() {
        deliveryCalls += 1;
        return deliveryReaderRecord();
      },
    };
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    const snapshot = buildInvoiceSnapshot({
      order: bundle.order,
      delivery: bundle.delivery,
      tenant: TENANT,
      documentNumber: "INV-TEST-6",
      documentDate: "2026-08-12",
    });
    const viewModel = buildPrintViewModel(snapshot);
    expect(orderCalls).toBe(1);
    expect(deliveryCalls).toBe(1);
    expect(viewModel.panels[0]).toBe(viewModel.panels[1]);
  });
});

describe("29+30+31. Output adapter live bisa langsung dijalankan lewat builder + view model yang sudah ada", () => {
  it("29. buildPurchaseOrderSnapshot berjalan dari output loadPurchaseOrderSource", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const order = await loadPurchaseOrderSource(orderReader, { companyId: "company-swa", orderId: "order-A" });
    const snapshot = buildPurchaseOrderSnapshot({
      order,
      tenant: TENANT,
      documentNumber: "PO-TEST-1",
      documentDate: "2026-08-10",
    });
    expect(snapshot.documentType).toBe("PURCHASE_ORDER");
    expect(snapshot.orderReference).toBe("SO-0001");
  });

  it("30. buildInvoiceSnapshot berjalan dari output loadInvoiceSource", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord()]);
    const bundle = await loadInvoiceSource(
      { orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A" },
    );
    const snapshot = buildInvoiceSnapshot({
      order: bundle.order,
      delivery: bundle.delivery,
      tenant: TENANT,
      documentNumber: "INV-TEST-7",
      documentDate: "2026-08-12",
    });
    expect(snapshot.documentType).toBe("INVOICE");
    expect(snapshot.deliveryReference).toBe("DO-0001");
  });

  it("31. Print view model tetap menghasilkan 2 panel identik dari satu snapshot hasil adapter live", async () => {
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const order = await loadPurchaseOrderSource(orderReader, { companyId: "company-swa", orderId: "order-A" });
    const snapshot = buildPurchaseOrderSnapshot({
      order,
      tenant: TENANT,
      documentNumber: "PO-TEST-2",
      documentDate: "2026-08-10",
    });
    const viewModel = buildPrintViewModel(snapshot);
    expect(viewModel.panels).toHaveLength(2);
    expect(viewModel.panels[0]).toBe(viewModel.panels[1]);
  });
});

describe("32. Builder/validator/view-model Document Engine tidak mengimpor repository/Supabase apa pun", () => {
  it("po-builder.ts, invoice-builder.ts, print-view-model.ts, source-validation.ts bebas dari import repository/Supabase", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["po-builder.ts", "invoice-builder.ts", "print-view-model.ts", "source-validation.ts"]) {
      const source = fs.readFileSync(path.resolve(__dirname, file), "utf-8");
      expect(source).not.toMatch(/@supabase\/supabase-js/);
      expect(source).not.toMatch(/getAdminClient|createClient\(/);
      expect(source).not.toMatch(/from ["']@\/lib\/(sales-orders|delivery)/);
    }
  });
});

describe("33. Adapter tidak memakai service-role client atau RLS bypass", () => {
  it("repository-adapter.ts tidak mengimpor @supabase/supabase-js atau service-role helper langsung", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.resolve(__dirname, "repository-adapter.ts"), "utf-8");
    expect(source).not.toMatch(/@supabase\/supabase-js/);
    expect(source).not.toMatch(/service_role/i);
    expect(source).not.toMatch(/getAdminClient/);
    expect(source).not.toMatch(/\bany\b/);
    // Tidak ada operasi tulis apa pun.
    expect(source).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(source).not.toMatch(/\.rpc\(/);
  });
});

// ---------------------------------------------------------------------------
// Production readers -- dibungkus di atas Pick<DeliveryRepositoryInterface,
// ...> bertipe, tanpa Supabase cloud (fake implementasi minimal method yang
// dibutuhkan saja). Membuktikan wiring ke repository RESMI benar, dan
// membuktikan gap data repository saat ini (LIMITATION pada laporan) secara
// end-to-end lewat ORDER_SOURCE_INCOMPLETE.
// ---------------------------------------------------------------------------

describe("ConfirmedOrderReader -- wrapper produksi di atas DeliveryRepositoryInterface.getConfirmedOrder", () => {
  function fakeConfirmedOrderRepo(
    snapshot: ConfirmedOrderSnapshot | null,
  ): Pick<DeliveryRepositoryInterface, "getConfirmedOrder"> {
    return {
      async getConfirmedOrder(salesOrderId, companyId) {
        if (!snapshot) return null;
        if (snapshot.id !== salesOrderId || snapshot.companyId !== companyId) return null;
        return snapshot;
      },
    };
  }

  it("memetakan ConfirmedOrderSnapshot ke OrderReaderRecord dengan orderLineId = sales_order_items.id asli", async () => {
    const repo = fakeConfirmedOrderRepo({
      id: "order-A",
      companyId: "company-swa",
      orderNumber: "SO-0001",
      customerName: "Toko Sari",
      status: "confirmed",
      items: [{ id: "soi-real-uuid", productName: "Indomie Goreng", unit: "dus", unitPrice: 85000, quantity: 10 }],
    });
    const reader = new ConfirmedOrderReader(repo);
    const record = await reader.getOrderForDocument("company-swa", "order-A");
    expect(record?.lines[0].orderLineId).toBe("soi-real-uuid");
    expect(record?.companyId).toBe("company-swa");
  });

  it("mengembalikan null bila getConfirmedOrder tidak menemukan order milik tenant ini (tenant-safe dari sisi repository)", async () => {
    const repo = fakeConfirmedOrderRepo(null);
    const reader = new ConfirmedOrderReader(repo);
    const record = await reader.getOrderForDocument("company-swa", "order-ghost");
    expect(record).toBeNull();
  });

  it("ConfirmedOrderSnapshot TANPA orderDate/customerId/salesman/discountAmount (mis. fake/legacy tanpa field baru) -> ORDER_SOURCE_INCOMPLETE, BUKAN diisi nilai karangan", async () => {
    const repo = fakeConfirmedOrderRepo({
      id: "order-A",
      companyId: "company-swa",
      orderNumber: "SO-0001",
      customerName: "Toko Sari",
      status: "confirmed",
      items: [{ id: "soi-1", productName: "Indomie Goreng", unit: "dus", unitPrice: 85000, quantity: 10 }],
    });
    const reader = new ConfirmedOrderReader(repo);
    try {
      await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
      expect.unreachable("seharusnya menolak karena data repository belum lengkap");
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("ORDER_SOURCE_INCOMPLETE");
      const message = (err as Error).message;
      expect(message).toContain("orderDate");
      expect(message).toContain("salesman.salesmanId");
      expect(message).toContain("discountAmount");
    }
  });

  it("ConfirmedOrderSnapshot LENGKAP (orderDate/customerId/salesman/discountAmount terisi) -> loadPurchaseOrderSource berhasil tanpa ORDER_SOURCE_INCOMPLETE", async () => {
    const repo = fakeConfirmedOrderRepo({
      id: "order-A",
      companyId: "company-swa",
      orderNumber: "SO-0001",
      customerName: "Toko Sari",
      status: "confirmed",
      orderDate: "2026-08-11",
      customerId: "cust-real-1",
      salesmanId: "sales-real-1",
      salesmanName: "Budi Santoso",
      items: [{ id: "soi-1", productName: "Indomie Goreng", unit: "dus", unitPrice: 85000, quantity: 10, discountAmount: 5000 }],
    });
    const reader = new ConfirmedOrderReader(repo);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.orderDate).toBe("2026-08-11");
    expect(order.store.customerId).toBe("cust-real-1");
    expect(order.salesman.salesmanId).toBe("sales-real-1");
    expect(order.salesman.salesmanName).toBe("Budi Santoso");
    expect(order.lines[0].discountAmount).toBe(5000);
  });

  it("discountAmount 0 (baris memang tanpa diskon) TETAP dianggap lengkap -- bukan diperlakukan sama dengan null/belum tersedia", async () => {
    const repo = fakeConfirmedOrderRepo({
      id: "order-A",
      companyId: "company-swa",
      orderNumber: "SO-0001",
      customerName: "Toko Sari",
      status: "confirmed",
      orderDate: "2026-08-11",
      customerId: "cust-real-1",
      salesmanId: "sales-real-1",
      salesmanName: "Budi Santoso",
      items: [{ id: "soi-1", productName: "Indomie Goreng", unit: "dus", unitPrice: 85000, quantity: 10, discountAmount: 0 }],
    });
    const reader = new ConfirmedOrderReader(repo);
    const order = await loadPurchaseOrderSource(reader, { companyId: "company-swa", orderId: "order-A" });
    expect(order.lines[0].discountAmount).toBe(0);
  });
});

describe("DeliveryVerificationReader -- wrapper produksi di atas DeliveryRepositoryInterface.getDelivery", () => {
  function deliveryRecord(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
    return {
      id: "delivery-A",
      companyId: "company-swa",
      salesOrderId: "order-A",
      attemptNumber: 1,
      assignedDriverId: "driver-1",
      status: "verified" as DeliveryStatus,
      items: [
        {
          id: "dli-1",
          salesOrderItemId: "soi-1",
          productName: "Indomie Goreng",
          unit: "dus",
          unitPrice: 85000,
          orderedQuantity: 10,
          dispatchedQuantity: 10,
          receivedQuantity: 10,
          rejectedQuantity: 0,
          returnedQuantity: 0,
          unresolvedQuantity: 0,
        },
      ],
      exceptions: [],
      evidence: [],
      recipient: null,
      deliveryNumber: "SWAS-SJ-20260811-000001",
      deliveryDate: "2026-08-11",
      ...overrides,
    };
  }

  function fakeDeliveryRepo(record: DeliveryRecord | null): Pick<DeliveryRepositoryInterface, "getDelivery"> {
    return {
      async getDelivery(deliveryId) {
        if (!record || record.id !== deliveryId) return null;
        return record;
      },
    };
  }

  it("memetakan status terminal -> billingStatus ELIGIBLE, memakai receivedQuantity sebagai verifiedQuantity (computeInvoiceEligibility)", async () => {
    const repo = fakeDeliveryRepo(deliveryRecord({ status: "verified" }));
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record?.billingStatus).toBe("ELIGIBLE");
    expect(record?.lines[0].verifiedQuantity).toBe(10);
    expect(record?.lines[0].orderLineId).toBe("soi-1");
  });

  it("memetakan status non-terminal -> billingStatus NOT_YET_ELIGIBLE", async () => {
    const repo = fakeDeliveryRepo(deliveryRecord({ status: "dispatched" }));
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record?.billingStatus).toBe("NOT_YET_ELIGIBLE");
  });

  it("rejectedQuantity TIDAK ikut menjadi verifiedQuantity (hanya receivedQuantity yang diverifikasi)", async () => {
    const repo = fakeDeliveryRepo(
      deliveryRecord({
        status: "partially_received",
        items: [
          {
            id: "dli-1",
            salesOrderItemId: "soi-1",
            productName: "Indomie Goreng",
            unit: "dus",
            unitPrice: 85000,
            orderedQuantity: 10,
            dispatchedQuantity: 10,
            receivedQuantity: 6,
            rejectedQuantity: 4,
            returnedQuantity: 0,
            unresolvedQuantity: 0,
          },
        ],
      }),
    );
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record?.lines[0].verifiedQuantity).toBe(6);
  });

  it("mengembalikan null bila companyId hasil fetch berbeda dari companyId terautentikasi (verifikasi pasca-fetch)", async () => {
    const repo = fakeDeliveryRepo(deliveryRecord({ companyId: "company-other" }));
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record).toBeNull();
  });

  it("mengembalikan null bila delivery tidak ditemukan", async () => {
    const repo = fakeDeliveryRepo(null);
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-ghost");
    expect(record).toBeNull();
  });

  it("memetakan deliveryNumber/deliveryDate dari DeliveryRecord.deliveryNumber/deliveryDate (Target 2) -- bukan lagi hardcoded null", async () => {
    const repo = fakeDeliveryRepo(deliveryRecord({ deliveryNumber: "SWAS-SJ-20260811-000042", deliveryDate: "2026-08-11" }));
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record?.deliveryNumber).toBe("SWAS-SJ-20260811-000042");
    expect(record?.deliveryDate).toBe("2026-08-11");
  });

  it("deliveryNumber/deliveryDate null (belum diterbitkan/historis) dipetakan apa adanya -- caller (loadInvoiceSource) yang menolak eksplisit", async () => {
    const repo = fakeDeliveryRepo(deliveryRecord({ deliveryNumber: null, deliveryDate: null }));
    const reader = new DeliveryVerificationReader(repo);
    const record = await reader.getDeliveryForDocument("company-swa", "delivery-A");
    expect(record?.deliveryNumber).toBeNull();
    expect(record?.deliveryDate).toBeNull();
  });
});
