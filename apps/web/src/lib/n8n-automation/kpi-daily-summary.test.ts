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

describe("kpiDailySummaryIdempotencyKey", () => {
  it("satu company + satu business date -> key unik", () => {
    expect(kpiDailySummaryIdempotencyKey("waluyo", "2026-08-10")).toBe("kpi_daily_summary:waluyo:2026-08-10");
  });
});
