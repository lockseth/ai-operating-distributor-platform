import { describe, expect, it } from "vitest";
import { buildSalesReportAfternoon, salesReportAfternoonIdempotencyKey } from "./sales-report-afternoon";
import type { SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";

const ACTIVE_PERIOD = { id: "period-1", name: "Agustus 2026", startDate: "2026-08-01", endDate: "2026-08-31" };

function projection(
  ecActual: number,
  orderActual: number,
  orderTarget: number | null,
  revenueActual: number,
  revenueTarget: number | null
): SalesKpiAchievementProjection {
  return {
    companyId: "waluyo",
    salespersonId: "sales-x",
    periodId: "period-1",
    periodName: "Agustus 2026",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    call: { kpiCode: "CALL", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    effectiveCall: { kpiCode: "EFFECTIVE_CALL", target: null, actual: ecActual, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    orderCount: {
      kpiCode: "ORDER_COUNT",
      target: orderTarget,
      actual: orderActual,
      remaining: orderTarget !== null ? Math.max(0, orderTarget - orderActual) : null,
      achievementPercentage: orderTarget !== null ? Math.round((orderActual / orderTarget) * 100) : null,
      pacingStatus: orderTarget !== null ? "ON_TRACK" : "DATA_INSUFFICIENT",
    },
    revenue: {
      kpiCode: "REVENUE",
      target: revenueTarget,
      actual: revenueActual,
      remaining: revenueTarget !== null ? Math.max(0, revenueTarget - revenueActual) : null,
      achievementPercentage: revenueTarget !== null ? Math.round((revenueActual / revenueTarget) * 100) : null,
      pacingStatus: revenueTarget !== null ? "ON_TRACK" : "DATA_INSUFFICIENT",
    },
    noo: { kpiCode: "NOO", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    sourceFreshness: orderTarget !== null || revenueTarget !== null ? "COMPLETE" : "DATA_INSUFFICIENT",
  };
}

describe("buildSalesReportAfternoon -- Laporan Sore Owner, n8n tidak menghitung sendiri", () => {
  it("tidak ada periode ACTIVE -> pesan eksplisit, tidak ada baris salesman", () => {
    const content = buildSalesReportAfternoon({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: null,
      lines: [],
    });
    expect(content.text).toContain("belum diaktifkan");
    expect(content.structured.status).toBe("NO_ACTIVE_PERIOD");
  });

  it("salesman dengan target -> EC-to-transaksi, omzet, dan tagihan tampil apa adanya", () => {
    const content = buildSalesReportAfternoon({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [
        {
          salesmanFullName: "Budi",
          projection: projection(5, 3, 5, 4_500_000, 10_000_000),
          tagihan: { outstandingCount: 4, outstandingTotal: 12_000_000, overdueCount: 1 },
        },
      ],
    });
    expect(content.text).toContain("EC-to-Transaksi: 5 kunjungan -> 3 transaksi (60%)");
    expect(content.text).toContain("Transaksi 3/5 (60%)");
    expect(content.text).toContain("Omzet Rp4.500.000/Rp10.000.000 (45%)");
    expect(content.text).toContain("Tagihan: 4 invoice outstanding (Rp12.000.000), 1 lewat jatuh tempo");

    const salesmen = content.structured.salesmen as Record<string, unknown>[];
    expect(salesmen[0].status).toBe("TARGET_SET");
    expect(salesmen[0].tagihan).toEqual({ outstandingCount: 4, outstandingTotal: 12_000_000, overdueCount: 1 });
  });

  it("tidak ada tagihan outstanding -> pesan eksplisit, bukan 0 telanjang", () => {
    const content = buildSalesReportAfternoon({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [
        {
          salesmanFullName: "Siti",
          projection: projection(2, 2, 2, 1_000_000, 1_000_000),
          tagihan: { outstandingCount: 0, outstandingTotal: 0, overdueCount: 0 },
        },
      ],
    });
    expect(content.text).toContain("Tagihan: tidak ada piutang outstanding");
  });

  it("belum ada kunjungan efektif -> EC-to-transaksi tidak membagi dengan nol", () => {
    const content = buildSalesReportAfternoon({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [
        {
          salesmanFullName: "Dedi",
          projection: projection(0, 0, 5, 0, 10_000_000),
          tagihan: { outstandingCount: 0, outstandingTotal: 0, overdueCount: 0 },
        },
      ],
    });
    expect(content.text).toContain("EC-to-Transaksi: belum ada kunjungan efektif hari ini");
  });

  it("salesman tanpa target -> 'Data belum cukup', bukan baris kosong/0", () => {
    const content = buildSalesReportAfternoon({
      tenantName: "Waluyo Distributor",
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      lines: [
        {
          salesmanFullName: "Wati",
          projection: projection(0, 0, null, 0, null),
          tagihan: { outstandingCount: 0, outstandingTotal: 0, overdueCount: 0 },
        },
      ],
    });
    expect(content.text).toContain("Wati: Data belum cukup");
    const salesmen = content.structured.salesmen as Record<string, unknown>[];
    expect(salesmen[0].status).toBe("TARGET_NOT_SET");
  });
});

describe("salesReportAfternoonIdempotencyKey", () => {
  it("satu company + satu business date -> key unik", () => {
    expect(salesReportAfternoonIdempotencyKey("waluyo", "2026-08-10")).toBe(
      "sales_report_afternoon:waluyo:2026-08-10"
    );
  });
});
