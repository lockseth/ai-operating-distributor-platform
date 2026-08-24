import { describe, it, expect } from "vitest";
import { buildOwnerChatContext } from "./context-builder";
import type { OwnerBusinessSnapshot } from "./snapshot";

function emptySnapshot(overrides: Partial<OwnerBusinessSnapshot> = {}): OwnerBusinessSnapshot {
  return {
    dateRange: { from: "2026-08-01T00:00:00.000Z", to: "2026-08-19T00:00:00.000Z" },
    topProducts: [],
    topCustomers: [],
    kpiStatus: null,
    riskSummary: {
      salesRisk: { high: 0, medium: 0, low: 0 },
      collectionRisk: { high: 0, medium: 0, low: 0 },
      behaviorChange: { high: 0, medium: 0, low: 0 },
      transactionRisk: { high: 0, medium: 0, low: 0 },
      unremittedCollection: { high: 0, medium: 0, low: 0 },
      callTiming: { high: 0, medium: 0, low: 0 },
    },
    ...overrides,
  };
}

describe("buildOwnerChatContext", () => {
  it("snapshot kosong total -> tidak crash, semua section bilang belum ada data/aman", () => {
    const text = buildOwnerChatContext(emptySnapshot());
    expect(text).toContain("Belum ada data penjualan produk");
    expect(text).toContain("Belum ada data order customer");
    expect(text).toContain("Belum ada periode KPI aktif");
    expect(text).toContain("Kewajaran Diskon Sales: aman");
    expect(text).toContain("Piutang Berisiko Macet: aman");
  });

  it("top products -> muncul urut dengan nama, qty, dan omzet format Rupiah", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        topProducts: [
          { product_name: "Saos Sambal 500ml", total_quantity: 120, total_revenue: 1_200_000 },
          { product_name: "Kecap Manis 1L", total_quantity: 80, total_revenue: 800_000 },
        ],
      }),
    );
    expect(text).toContain("1. Saos Sambal 500ml -- 120 unit terjual, omzet Rp1.200.000");
    expect(text).toContain("2. Kecap Manis 1L -- 80 unit terjual, omzet Rp800.000");
  });

  it("top customers -> muncul urut dengan nama, jumlah order, dan omzet", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        topCustomers: [
          { customer_id: "c1", customer_name: "Toko Sumber Rejeki", order_count: 5, total_revenue: 2_500_000 },
        ],
      }),
    );
    expect(text).toContain("1. Toko Sumber Rejeki -- 5 order, omzet Rp2.500.000");
  });

  it("KPI tanpa target -> bilang belum ada target, tetap tampilkan pencapaian", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        kpiStatus: {
          CALL: { target: 0, achieved: 12, hasTarget: false },
          EFFECTIVE_CALL: { target: 0, achieved: 0, hasTarget: false },
          ORDER_COUNT: { target: 0, achieved: 0, hasTarget: false },
          REVENUE: { target: 0, achieved: 0, hasTarget: false },
          NOO: { target: 0, achieved: 0, hasTarget: false },
        },
      }),
    );
    expect(text).toContain("Call: belum ada target di-set (pencapaian sejauh ini 12)");
  });

  it("KPI dengan target -> hitung persentase, REVENUE format Rupiah, lainnya angka biasa", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        kpiStatus: {
          CALL: { target: 100, achieved: 80, hasTarget: true },
          EFFECTIVE_CALL: { target: 0, achieved: 0, hasTarget: false },
          ORDER_COUNT: { target: 0, achieved: 0, hasTarget: false },
          REVENUE: { target: 100_000_000, achieved: 45_000_000, hasTarget: true },
          NOO: { target: 0, achieved: 0, hasTarget: false },
        },
      }),
    );
    expect(text).toContain("Call: 80 dari target 100 (80%)");
    expect(text).toContain("Revenue: Rp45.000.000 dari target Rp100.000.000 (45%)");
  });

  it("KPI target 0 -> tidak divide-by-zero (persentase 0%, tidak crash)", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        kpiStatus: {
          CALL: { target: 0, achieved: 5, hasTarget: true },
          EFFECTIVE_CALL: { target: 0, achieved: 0, hasTarget: false },
          ORDER_COUNT: { target: 0, achieved: 0, hasTarget: false },
          REVENUE: { target: 0, achieved: 0, hasTarget: false },
          NOO: { target: 0, achieved: 0, hasTarget: false },
        },
      }),
    );
    expect(text).toContain("Call: 5 dari target 0 (0%)");
  });

  it("risk ada yang tinggi -> muncul angka per tier, bukan 'aman'", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        riskSummary: {
          salesRisk: { high: 1, medium: 2, low: 0 },
          collectionRisk: { high: 0, medium: 0, low: 1 },
          behaviorChange: { high: 0, medium: 0, low: 0 },
          transactionRisk: { high: 0, medium: 0, low: 0 },
          unremittedCollection: { high: 0, medium: 0, low: 0 },
          callTiming: { high: 0, medium: 0, low: 0 },
        },
      }),
    );
    expect(text).toContain("Kewajaran Diskon Sales: 1 risiko tinggi, 2 risiko sedang, 0 risiko rendah.");
    expect(text).toContain("Piutang Berisiko Macet: 0 risiko tinggi, 0 risiko sedang, 1 risiko rendah.");
    expect(text).toContain("Perubahan Perilaku Customer: aman");
  });

  it("Gate P4.18/P4.19: Klaim Belum Diformalkan dan Kunjungan Mencurigakan ikut muncul di ringkasan risiko", () => {
    const text = buildOwnerChatContext(
      emptySnapshot({
        riskSummary: {
          salesRisk: { high: 0, medium: 0, low: 0 },
          collectionRisk: { high: 0, medium: 0, low: 0 },
          behaviorChange: { high: 0, medium: 0, low: 0 },
          transactionRisk: { high: 0, medium: 0, low: 0 },
          unremittedCollection: { high: 1, medium: 0, low: 0 },
          callTiming: { high: 0, medium: 1, low: 0 },
        },
      }),
    );
    expect(text).toContain("Klaim Pembayaran Belum Diformalkan: 1 risiko tinggi, 0 risiko sedang, 0 risiko rendah.");
    expect(text).toContain("Kunjungan Mencurigakan (Jarak Waktu): 0 risiko tinggi, 1 risiko sedang, 0 risiko rendah.");
  });

  it("Gate P4.18/P4.19 aman -> ikut bilang 'aman' seperti 4 fitur lain (bukan hilang dari daftar)", () => {
    const text = buildOwnerChatContext(emptySnapshot());
    expect(text).toContain("Klaim Pembayaran Belum Diformalkan: aman");
    expect(text).toContain("Kunjungan Mencurigakan (Jarak Waktu): aman");
  });

  it("output selalu string (tidak pernah undefined/null), bisa langsung dipakai sebagai prompt", () => {
    const text = buildOwnerChatContext(emptySnapshot());
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
