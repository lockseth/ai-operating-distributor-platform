// =============================================================================
// Unit test -- lib/document-engine/issuance.ts + issuance-repository.ts
// (InMemory). Membuktikan orkestrasi (profil tenant lengkap -> alokasi nomor
// -> build snapshot -> persist versioned) benar terlepas dari I/O; concurrency
// Postgres sungguhan dibuktikan terpisah lewat integration test (lihat
// issuance-repository.integration.test.ts).
// =============================================================================

import { describe, expect, it } from "vitest";
import { DocumentSourceError } from "./errors";
import { InMemoryDocumentIssuanceRepository, type CompanyProfile } from "./issuance-repository";
import { issueInvoiceDocument, issuePurchaseOrderDocument, jakartaBusinessDate } from "./issuance";
import { MAX_DOCUMENT_LINE_ITEMS } from "./source-validation";
import type { DeliveryReader, OrderReader, OrderReaderRecord, DeliveryReaderRecord } from "./repository-adapter";

const COMPLETE_PROFILE: CompanyProfile = {
  companyId: "company-swa",
  name: "PT SUMBER WARNA ALAM SUDIADA",
  legalAddress: "Jl. Cendana Raya Talun Cirebon 45171",
  contactEmail: "sumberwanaalamsudiada@gmail.com",
  contactPhone: "085185905859",
  documentNumberPrefix: "SWAS",
  logoUrl: null,
};

function orderReaderRecord(overrides: Partial<OrderReaderRecord> = {}): OrderReaderRecord {
  return {
    orderId: "order-A",
    companyId: "company-swa",
    orderNumber: "SO-0001",
    orderDate: "2026-08-10",
    customerId: "cust-1",
    customerCode: "CUST-1",
    customerName: "Toko Sari",
    customerAddress: "Jl. Mangga 1",
    customerPhone: "081200000001",
    picName: "Ibu Sari",
    salesmanId: "sales-1",
    salesmanName: "Budi",
    paymentTermsDays: 14,
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
    ...overrides,
  };
}

function deliveryReaderRecord(overrides: Partial<DeliveryReaderRecord> = {}): DeliveryReaderRecord {
  return {
    deliveryId: "delivery-A",
    companyId: "company-swa",
    orderId: "order-A",
    deliveryNumber: "SWAS-SJ-20260811-000001",
    deliveryDate: "2026-08-11",
    billingStatus: "ELIGIBLE",
    lines: [
      {
        deliveryLineId: "dline-1",
        orderLineId: "soi-1",
        productCode: "SKU-1",
        productName: "Indomie Goreng",
        productType: "Mie Instan",
        unit: "dus",
        orderedQuantity: 10,
        verifiedQuantity: 10,
        unitPrice: 85000,
      },
    ],
    ...overrides,
  };
}

function makeOrderReader(records: OrderReaderRecord[]): OrderReader {
  return {
    async getOrderForDocument(companyId, orderId) {
      const record = records.find((r) => r.orderId === orderId);
      if (!record || record.companyId !== companyId) return null;
      return record;
    },
  };
}

function makeDeliveryReader(records: DeliveryReaderRecord[]): DeliveryReader {
  return {
    async getDeliveryForDocument(companyId, deliveryId) {
      const record = records.find((r) => r.deliveryId === deliveryId);
      if (!record || record.companyId !== companyId) return null;
      return record;
    },
  };
}

const FIXED_NOW = () => new Date("2026-08-12T03:00:00.000Z"); // 10:00 WIB

describe("jakartaBusinessDate", () => {
  it("mengonversi UTC ke tanggal bisnis Asia/Jakarta (UTC+7)", () => {
    // 2026-08-12T20:00:00Z -> 2026-08-13T03:00 WIB -> tanggal bisnis 13, bukan 12.
    expect(jakartaBusinessDate(() => new Date("2026-08-12T20:00:00.000Z"))).toBe("2026-08-13");
    // 2026-08-12T03:00:00Z -> 2026-08-12T10:00 WIB -> tetap tanggal 12.
    expect(jakartaBusinessDate(FIXED_NOW)).toBe("2026-08-12");
  });
});

describe("issuePurchaseOrderDocument", () => {
  it("menerbitkan PO versi 1: nomor teralokasi, snapshot benar, source tenant-scoped", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);

    const result = await issuePurchaseOrderDocument(
      { issuance: repo, orderReader },
      { companyId: "company-swa", orderId: "order-A", issuedBy: "user-1", now: FIXED_NOW },
    );

    expect(result.record.version).toBe(1);
    expect(result.record.documentNumber).toMatch(/^SWAS-PO-20260812-\d{6}$/);
    expect(result.snapshot.documentType).toBe("PURCHASE_ORDER");
    expect(result.snapshot.documentNumber).toBe(result.record.documentNumber);
    expect(result.snapshot.orderReference).toBe("SO-0001");
  });

  it("menolak COMPANY_PROFILE_INCOMPLETE bila legal_address/contact_email/contact_phone/prefix belum lengkap", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", { ...COMPLETE_PROFILE, legalAddress: null });
    const orderReader = makeOrderReader([orderReaderRecord()]);

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toThrow(DocumentSourceError);
    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "COMPANY_PROFILE_INCOMPLETE" });
  });

  it("menolak company yang tidak ditemukan (COMPANY_MISMATCH) sebelum menyentuh order reader", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    const orderReader = makeOrderReader([orderReaderRecord()]);

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-ghost", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "COMPANY_MISMATCH" });
  });

  it("revisi (supersedesDocumentId): version 2 menggantikan version 1, hanya satu versi aktif", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);

    const v1 = await issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: "user-1", now: FIXED_NOW });
    const v2 = await issuePurchaseOrderDocument(
      { issuance: repo, orderReader },
      { companyId: "company-swa", orderId: "order-A", issuedBy: "user-1", now: FIXED_NOW, supersedesDocumentId: v1.record.id },
    );

    expect(v2.record.version).toBe(2);
    expect(v2.record.id).not.toBe(v1.record.id);
  });

  it("penerbitan kedua TANPA supersedesDocumentId untuk order yang sama ditolak (DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE)", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);

    await issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: "user-1", now: FIXED_NOW });

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: "user-1", now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE" });
  });

  it("order dari company lain ditolak (TENANT_CONTEXT_MISMATCH via loadPurchaseOrderSource) -- reuse validasi source-validation existing", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord({ companyId: "company-other" })]);

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });

  it("satu baris melebihi batas maksimum -- REJECT DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED SEBELUM alokasi nomor dokumen, tidak ada nomor tertinggal", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const tooManyLines = Array.from({ length: MAX_DOCUMENT_LINE_ITEMS + 1 }, (_, i) => ({
      orderLineId: `soi-${i + 1}`,
      productCode: `SKU-${i + 1}`,
      productName: "Indomie Goreng",
      productType: "Mie Instan",
      unit: "dus",
      quantity: 1,
      unitPrice: 85000,
      discountAmount: 0,
    }));
    const orderReader = makeOrderReader([orderReaderRecord({ lines: tooManyLines })]);

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED" });

    // Penerbitan berikutnya (valid) tetap mendapat nomor urut PERTAMA --
    // membuktikan attempt yang ditolak di atas TIDAK membakar nomor dokumen.
    const validOrderReader = makeOrderReader([orderReaderRecord()]);
    const result = await issuePurchaseOrderDocument(
      { issuance: repo, orderReader: validOrderReader },
      { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW },
    );
    expect(result.record.documentNumber).toMatch(/-000001$/);
  });
});

describe("issuePurchaseOrderDocument -- F. batas domain vs kapasitas panel (LOCK 'AODP WALUYO -- CONTINUATION PANEL PRINT GATE')", () => {
  function linesOfCount(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      orderLineId: `soi-${i + 1}`,
      productCode: `SKU-${i + 1}`,
      productName: "Indomie Goreng",
      productType: "Mie Instan",
      unit: "dus",
      quantity: 1,
      unitPrice: 85000,
      discountAmount: 0,
    }));
  }

  it.each([10, 11, 25, 30])("%i baris item -- ISSUED (kapasitas panel TIDAK dipakai untuk menolak issuance dokumen valid)", async (count) => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord({ lines: linesOfCount(count) })]);

    const result = await issuePurchaseOrderDocument(
      { issuance: repo, orderReader },
      { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW },
    );
    expect(result.record.version).toBe(1);
    expect(result.snapshot.lines).toHaveLength(count);
  });

  it("31 baris item -- REJECT (melewati batas domain 30), bukan karena melebihi satu panel (10)", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord({ lines: linesOfCount(31) })]);

    await expect(
      issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: "DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED" });
  });
});

describe("issueInvoiceDocument", () => {
  it("menerbitkan Invoice versi 1: source order+delivery, snapshot deliveryReference terisi", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord()]);

    const result = await issueInvoiceDocument(
      { issuance: repo, orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A", issuedBy: "user-1", now: FIXED_NOW },
    );

    expect(result.record.version).toBe(1);
    expect(result.record.documentNumber).toMatch(/^SWAS-INV-20260812-\d{6}$/);
    expect(result.snapshot.documentType).toBe("INVOICE");
    expect(result.snapshot.deliveryReference).toBe("SWAS-SJ-20260811-000001");
  });

  it("PO dan Invoice untuk order yang sama masing-masing punya source_key sendiri -- tidak saling menabrak single-active constraint", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord()]);

    const po = await issuePurchaseOrderDocument({ issuance: repo, orderReader }, { companyId: "company-swa", orderId: "order-A", issuedBy: null, now: FIXED_NOW });
    const inv = await issueInvoiceDocument(
      { issuance: repo, orderReader, deliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A", issuedBy: null, now: FIXED_NOW },
    );

    expect(po.record.version).toBe(1);
    expect(inv.record.version).toBe(1);
  });

  it("delivery belum eligible (belum terverifikasi) ditolak lewat validasi source existing", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const orderReader = makeOrderReader([orderReaderRecord()]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ billingStatus: "NOT_YET_ELIGIBLE" })]);

    await expect(
      issueInvoiceDocument(
        { issuance: repo, orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A", issuedBy: null, now: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ code: "DELIVERY_NOT_BILLABLE" });
  });

  it("satu baris melebihi batas maksimum tertagih -- REJECT DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED SEBELUM alokasi nomor dokumen, tidak ada nomor tertinggal", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    const tooManyOrderLines = Array.from({ length: MAX_DOCUMENT_LINE_ITEMS + 1 }, (_, i) => ({
      orderLineId: `soi-${i + 1}`,
      productCode: `SKU-${i + 1}`,
      productName: "Indomie Goreng",
      productType: "Mie Instan",
      unit: "dus",
      quantity: 1,
      unitPrice: 85000,
      discountAmount: 0,
    }));
    const tooManyDeliveryLines = Array.from({ length: MAX_DOCUMENT_LINE_ITEMS + 1 }, (_, i) => ({
      deliveryLineId: `dline-${i + 1}`,
      orderLineId: `soi-${i + 1}`,
      productCode: `SKU-${i + 1}`,
      productName: "Indomie Goreng",
      productType: "Mie Instan",
      unit: "dus",
      orderedQuantity: 1,
      verifiedQuantity: 1,
      unitPrice: 85000,
    }));
    const orderReader = makeOrderReader([orderReaderRecord({ lines: tooManyOrderLines })]);
    const deliveryReader = makeDeliveryReader([deliveryReaderRecord({ lines: tooManyDeliveryLines })]);

    await expect(
      issueInvoiceDocument(
        { issuance: repo, orderReader, deliveryReader },
        { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A", issuedBy: null, now: FIXED_NOW },
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED" });

    // Penerbitan berikutnya (valid, delivery lain) tetap mendapat nomor urut
    // PERTAMA -- membuktikan attempt yang ditolak di atas TIDAK membakar nomor
    // dokumen INVOICE.
    const validOrderReader = makeOrderReader([orderReaderRecord()]);
    const validDeliveryReader = makeDeliveryReader([deliveryReaderRecord()]);
    const result = await issueInvoiceDocument(
      { issuance: repo, orderReader: validOrderReader, deliveryReader: validDeliveryReader },
      { companyId: "company-swa", orderId: "order-A", deliveryId: "delivery-A", issuedBy: null, now: FIXED_NOW },
    );
    expect(result.record.documentNumber).toMatch(/-000001$/);
  });
});

describe("InMemoryDocumentIssuanceRepository.issueDeliveryNote", () => {
  it("menerbitkan delivery_number/delivery_date pada delivery status=planned", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    repo.deliveries.set("delivery-A", { companyId: "company-swa", status: "planned", deliveryNumber: null, deliveryDate: null });

    const result = await repo.issueDeliveryNote("delivery-A");
    expect(result.deliveryNumber).toMatch(/^SWAS-SJ-\d{8}-\d{6}$/);
  });

  it("menolak re-issue pada delivery yang sudah punya delivery_number", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    repo.deliveries.set("delivery-A", { companyId: "company-swa", status: "planned", deliveryNumber: null, deliveryDate: null });

    await repo.issueDeliveryNote("delivery-A");
    await expect(repo.issueDeliveryNote("delivery-A")).rejects.toMatchObject({ code: "DELIVERY_ALREADY_ISSUED" });
  });

  it("menolak issuance setelah dispatched (harus sebelum dispatch)", async () => {
    const repo = new InMemoryDocumentIssuanceRepository();
    repo.companies.set("company-swa", COMPLETE_PROFILE);
    repo.deliveries.set("delivery-A", { companyId: "company-swa", status: "dispatched", deliveryNumber: null, deliveryDate: null });

    await expect(repo.issueDeliveryNote("delivery-A")).rejects.toMatchObject({ code: "DELIVERY_NOT_ISSUABLE" });
  });
});
