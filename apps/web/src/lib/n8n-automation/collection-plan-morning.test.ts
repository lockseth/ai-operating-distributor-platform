import { describe, expect, it } from "vitest";
import {
  buildCollectionPlanMorning,
  collectionPlanMorningIdempotencyKey,
  type CollectionPlanEntryLine,
} from "./collection-plan-morning";

function overdueEntry(days: number): CollectionPlanEntryLine {
  return {
    customerName: "Toko Sumber Rejeki",
    invoiceNumber: "AODPDEV-INV-20260818-000001",
    outstandingBalance: 2_500_000,
    isOverdue: true,
    daysOverdue: days,
    hasOverduePromise: false,
    daysSincePromise: null,
    promisedAmount: null,
  };
}

function brokenPromiseEntry(days: number, amount: number): CollectionPlanEntryLine {
  return {
    customerName: "Toko Makmur Jaya",
    invoiceNumber: "AODPDEV-INV-20260819-000002",
    outstandingBalance: amount,
    isOverdue: false,
    daysOverdue: null,
    hasOverduePromise: true,
    daysSincePromise: days,
    promisedAmount: amount,
  };
}

describe("buildCollectionPlanMorning -- Rencana Penagihan Owner, n8n tidak menghitung sendiri", () => {
  it("tidak ada toko yang perlu ditagih -> pesan eksplisit, bukan daftar kosong", () => {
    const content = buildCollectionPlanMorning({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-22",
      lines: [{ salesmanFullName: "Budi", entries: [] }],
    });
    expect(content.text).toContain("Tidak ada toko yang perlu ditagih hari ini");
    expect(content.structured.status).toBe("NO_TARGETS");
  });

  it("invoice overdue -> tampil dengan jumlah hari overdue", () => {
    const content = buildCollectionPlanMorning({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-22",
      lines: [{ salesmanFullName: "Budi", entries: [overdueEntry(3)] }],
    });
    expect(content.text).toContain("Budi (1 toko):");
    expect(content.text).toContain("Toko Sumber Rejeki -- AODPDEV-INV-20260818-000001 (2500000) -- overdue 3 hari");
    expect(content.structured.status).toBe("HAS_TARGETS");
  });

  it("janji bayar terlewat -> tampil dengan jumlah hari lewat + nominal janji", () => {
    const content = buildCollectionPlanMorning({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-22",
      lines: [{ salesmanFullName: "Siti", entries: [brokenPromiseEntry(2, 1_000_000)] }],
    });
    expect(content.text).toContain("janji bayar lewat 2 hari (1000000)");
  });

  it("invoice dengan kedua sinyal -> satu baris, kedua alasan tergabung", () => {
    const combined: CollectionPlanEntryLine = {
      ...overdueEntry(5),
      hasOverduePromise: true,
      daysSincePromise: 1,
      promisedAmount: 2_500_000,
    };
    const content = buildCollectionPlanMorning({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-22",
      lines: [{ salesmanFullName: "Budi", entries: [combined] }],
    });
    expect(content.text).toContain("overdue 5 hari, janji bayar lewat 1 hari (2500000)");
    // satu baris entri, bukan dua baris terpisah untuk invoice yang sama
    expect(content.text.match(/AODPDEV-INV-20260818-000001/g)?.length).toBe(1);
  });

  it("salesman tanpa target diselipkan di antara yang ada target -> tetap tidak tampil", () => {
    const content = buildCollectionPlanMorning({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-22",
      lines: [
        { salesmanFullName: "Budi", entries: [overdueEntry(1)] },
        { salesmanFullName: "Dedi", entries: [] },
      ],
    });
    expect(content.text).toContain("Budi (1 toko):");
    expect(content.text).not.toContain("Dedi");
  });
});

describe("collectionPlanMorningIdempotencyKey", () => {
  it("satu company + satu business date -> key unik", () => {
    expect(collectionPlanMorningIdempotencyKey("waluyo", "2026-08-22")).toBe(
      "collection_plan_morning:waluyo:2026-08-22"
    );
  });
});
