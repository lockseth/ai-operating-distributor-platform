import { describe, expect, it } from "vitest";
import { buildKpiDailySummary, kpiDailySummaryIdempotencyKey } from "./kpi-daily-summary";
import type { SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";

const ACTIVE_PERIOD = { id: "period-1", name: "Agustus 2026", startDate: "2026-08-01", endDate: "2026-08-31" };

function projection(callActual: number, callTarget: number | null, ecActual: number, ecTarget: number | null): SalesKpiAchievementProjection {
  return {
    companyId: "waluyo",
    salespersonId: "sales-x",
    periodId: "period-1",
    periodName: "Agustus 2026",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    call: { kpiCode: "CALL", target: callTarget, actual: callActual, remaining: callTarget !== null ? Math.max(0, callTarget - callActual) : null, achievementPercentage: callTarget !== null ? Math.round((callActual / callTarget) * 100) : null, pacingStatus: callTarget !== null ? "ON_TRACK" : "DATA_INSUFFICIENT" },
    effectiveCall: { kpiCode: "EFFECTIVE_CALL", target: ecTarget, actual: ecActual, remaining: ecTarget !== null ? Math.max(0, ecTarget - ecActual) : null, achievementPercentage: ecTarget !== null ? Math.round((ecActual / ecTarget) * 100) : null, pacingStatus: ecTarget !== null ? "ON_TRACK" : "DATA_INSUFFICIENT" },
    orderCount: { kpiCode: "ORDER_COUNT", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    revenue: { kpiCode: "REVENUE", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    noo: { kpiCode: "NOO", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    sourceFreshness: callTarget !== null || ecTarget !== null ? "COMPLETE" : "DATA_INSUFFICIENT",
  };
}

describe("buildKpiDailySummary -- agregat Owner, n8n tidak menghitung sendiri", () => {
  it("tidak ada periode ACTIVE -> pesan eksplisit, tidak ada baris salesman", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: null,
      lines: [],
    });
    expect(content.text).toContain("belum diaktifkan");
    expect(content.structured.status).toBe("NO_ACTIVE_PERIOD");
  });

  it("beberapa salesman dengan target -> setiap baris memakai angka projection apa adanya", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [
        { salesmanFullName: "Budi", projection: projection(4, 10, 2, 5) },
        { salesmanFullName: "Siti", projection: projection(8, 8, 8, 4) },
      ],
    });
    expect(content.text).toContain("Budi: Call 4/10 (40%), EC 2/5 (40%), EC Rate 50%");
    expect(content.text).toContain("Siti: Call 8/8 (100%), EC 8/4 (200%)"); // over-achievement tetap ditampilkan apa adanya
  });

  it("salesman tanpa target -> 'Data belum cukup', bukan baris kosong/0", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [{ salesmanFullName: "Dedi", projection: projection(0, null, 0, null) }],
    });
    expect(content.text).toContain("Dedi: Data belum cukup");
    const salesmen = content.structured.salesmen as Record<string, unknown>[];
    expect(salesmen[0].status).toBe("TARGET_NOT_SET");
  });
});

describe("buildKpiDailySummary -- Gate P4.17: calon churn (HIGH/MEDIUM)", () => {
  it("tidak ada churnCandidates -> tidak ada bagian 'Calon Churn' sama sekali (bukan baris kosong)", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
    });
    expect(content.text).not.toContain("Calon Churn");
    expect(content.structured.churnCandidates).toEqual([]);
  });

  it("churnCandidates array kosong -> sama seperti tidak ada, tidak muncul di teks", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      churnCandidates: [],
    });
    expect(content.text).not.toContain("Calon Churn");
  });

  it("ada calon churn -> muncul dengan jumlah, nama toko, level risiko, dan hari sejak order terakhir", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      churnCandidates: [
        { customerName: "Toko Sumber Rejeki", riskLevel: "HIGH", daysSinceLastOrder: 65 },
        { customerName: "Toko Makmur Jaya", riskLevel: "MEDIUM", daysSinceLastOrder: 40 },
      ],
    });
    expect(content.text).toContain("Calon Churn (2 toko):");
    expect(content.text).toContain("Toko Sumber Rejeki -- risiko Tinggi, tidak order 65 hari");
    expect(content.text).toContain("Toko Makmur Jaya -- risiko Sedang, tidak order 40 hari");
  });

  it("churn tetap muncul walau periode KPI belum diaktifkan", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: null,
      lines: [],
      churnCandidates: [{ customerName: "Toko A", riskLevel: "HIGH", daysSinceLastOrder: 70 }],
    });
    expect(content.text).toContain("belum diaktifkan");
    expect(content.text).toContain("Calon Churn (1 toko):");
    expect(content.structured.status).toBe("NO_ACTIVE_PERIOD");
  });
});

describe("buildKpiDailySummary -- Gate P4.20: 4 fitur Business Guard baru (HIGH saja)", () => {
  it("discountAnomalyCandidates kosong/tidak ada -> tidak ada bagian 'Anomali Pengajuan Diskon'", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      discountAnomalyCandidates: [],
    });
    expect(content.text).not.toContain("Anomali Pengajuan Diskon");
    expect(content.structured.discountAnomalyCandidates).toEqual([]);
  });

  it("ada anomali diskon -> muncul dengan nama sales, jumlah pengajuan, dan persentase ditolak", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      discountAnomalyCandidates: [{ salesName: "Budi", riskLevel: "HIGH", totalRequests: 12, rejectionRate: 0.5 }],
    });
    expect(content.text).toContain("Anomali Pengajuan Diskon (1):");
    expect(content.text).toContain("Budi -- 12 pengajuan, 50% ditolak");
  });

  it("collectionRiskCandidates kosong/tidak ada -> tidak ada bagian 'Piutang Berisiko Macet'", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      collectionRiskCandidates: [],
    });
    expect(content.text).not.toContain("Piutang Berisiko Macet");
    expect(content.structured.collectionRiskCandidates).toEqual([]);
  });

  it("ada piutang macet -> muncul dengan nama customer, nominal Rupiah, dan umur hari", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      collectionRiskCandidates: [
        { customerName: "Toko Sumber Rejeki", riskLevel: "HIGH", totalOutstandingAmount: 5_000_000, maxAgeDays: 95 },
      ],
    });
    expect(content.text).toContain("Piutang Berisiko Macet (1):");
    expect(content.text).toContain("Toko Sumber Rejeki -- Rp5.000.000, 95 hari lewat jatuh tempo");
  });

  it("ada piutang macet dengan maxAgeDays null -> label 'umur tidak diketahui', tidak crash", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      collectionRiskCandidates: [{ customerName: "Toko A", riskLevel: "HIGH", totalOutstandingAmount: 1_000_000, maxAgeDays: null }],
    });
    expect(content.text).toContain("Toko A -- Rp1.000.000, umur tidak diketahui");
  });

  it("behaviorChangeCandidates kosong/tidak ada -> tidak ada bagian 'Perubahan Perilaku Customer'", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      behaviorChangeCandidates: [],
    });
    expect(content.text).not.toContain("Perubahan Perilaku Customer");
    expect(content.structured.behaviorChangeCandidates).toEqual([]);
  });

  it("ada perubahan perilaku -> muncul dengan nama customer dan hari sejak order terakhir", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      behaviorChangeCandidates: [{ customerName: "Toko Makmur", riskLevel: "HIGH", daysSinceLastOrder: 80 }],
    });
    expect(content.text).toContain("Perubahan Perilaku Customer (1):");
    expect(content.text).toContain("Toko Makmur -- 80 hari sejak order terakhir");
  });

  it("transactionRiskCandidates kosong/tidak ada -> tidak ada bagian 'Transaksi Berisiko'", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      transactionRiskCandidates: [],
    });
    expect(content.text).not.toContain("Transaksi Berisiko");
    expect(content.structured.transactionRiskCandidates).toEqual([]);
  });

  it("ada transaksi berisiko -> muncul dengan nomor order, nama customer, dan nominal Rupiah", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [],
      transactionRiskCandidates: [
        { orderNumber: "SO-2608-0099", customerName: "Toko Baru", riskLevel: "HIGH", orderTotalAmount: 7_500_000 },
      ],
    });
    expect(content.text).toContain("Transaksi Berisiko (1):");
    expect(content.text).toContain("SO-2608-0099 -- Toko Baru, Rp7.500.000");
  });

  it("semua bagian Business Guard bisa muncul sekaligus tanpa saling menimpa, plus tetap muncul walau periode belum aktif", () => {
    const content = buildKpiDailySummary({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: null,
      lines: [],
      churnCandidates: [{ customerName: "Toko Churn", riskLevel: "HIGH", daysSinceLastOrder: 70 }],
      unremittedCandidates: [{ collectorName: "Sales A", customerName: "Toko Unremitted", riskLevel: "HIGH", daysElapsed: 8 }],
      callTimingCandidates: [{ salespersonName: "Sales B", callDate: "2026-08-10", riskLevel: "HIGH", minGapSeconds: 45, tightGapCount: 2 }],
      discountAnomalyCandidates: [{ salesName: "Sales C", riskLevel: "HIGH", totalRequests: 5, rejectionRate: 0.8 }],
      collectionRiskCandidates: [{ customerName: "Toko Piutang", riskLevel: "HIGH", totalOutstandingAmount: 2_000_000, maxAgeDays: 100 }],
      behaviorChangeCandidates: [{ customerName: "Toko Perilaku", riskLevel: "HIGH", daysSinceLastOrder: 60 }],
      transactionRiskCandidates: [{ orderNumber: "SO-1", customerName: "Toko Order", riskLevel: "HIGH", orderTotalAmount: 3_000_000 }],
    });
    expect(content.text).toContain("belum diaktifkan");
    expect(content.text).toContain("Calon Churn (1 toko):");
    expect(content.text).toContain("Klaim Pembayaran Belum Diformalkan (1):");
    expect(content.text).toContain("Kunjungan Mencurigakan (1):");
    expect(content.text).toContain("Anomali Pengajuan Diskon (1):");
    expect(content.text).toContain("Piutang Berisiko Macet (1):");
    expect(content.text).toContain("Perubahan Perilaku Customer (1):");
    expect(content.text).toContain("Transaksi Berisiko (1):");
  });
});

describe("kpiDailySummaryIdempotencyKey", () => {
  it("satu company + satu business date -> key unik", () => {
    expect(kpiDailySummaryIdempotencyKey("waluyo", "2026-08-10")).toBe("kpi_daily_summary:waluyo:2026-08-10");
  });
});
