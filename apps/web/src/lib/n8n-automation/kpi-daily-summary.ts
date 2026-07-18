// =============================================================================
// KPI Daily Summary -- presenter untuk Owner (WhatsApp channel, dry-run only
// pada phase ini -- lihat dispatch route, tidak pernah mengirim WhatsApp
// nyata). Konten SELALU dari data lib/sales-kpi/* per salesman, dirangkai
// di sini, tidak dihitung ulang.
// =============================================================================

import type { ActiveSalesKpiPeriod, SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";

export interface KpiDailySummarySalesmanLine {
  salesmanFullName: string;
  projection: SalesKpiAchievementProjection | null;
}

export interface KpiDailySummaryContext {
  tenantName: string;
  businessDate: string;
  activePeriod: ActiveSalesKpiPeriod | null;
  lines: KpiDailySummarySalesmanLine[];
}

export interface KpiDailySummaryContent {
  text: string;
  structured: Record<string, unknown>;
}

function ecRateOf(projection: SalesKpiAchievementProjection): number | null {
  return projection.call.actual > 0
    ? Math.round((projection.effectiveCall.actual / projection.call.actual) * 100)
    : null;
}

export function buildKpiDailySummary(ctx: KpiDailySummaryContext): KpiDailySummaryContent {
  const lines: string[] = [];
  lines.push(`${ctx.tenantName} -- KPI Daily Summary ${ctx.businessDate}`);
  lines.push("");

  if (!ctx.activePeriod) {
    lines.push("Periode KPI belum diaktifkan. Belum ada target resmi untuk ditampilkan.");
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
        salesmen: [],
      },
    };
  }

  lines.push(`Periode: ${ctx.activePeriod.name}`);
  lines.push("");

  const structuredSalesmen: Record<string, unknown>[] = [];

  for (const line of ctx.lines) {
    if (!line.projection || (line.projection.call.target === null && line.projection.effectiveCall.target === null)) {
      lines.push(`${line.salesmanFullName}: Data belum cukup -- target belum ditetapkan`);
      structuredSalesmen.push({ salesmanFullName: line.salesmanFullName, status: "TARGET_NOT_SET" });
      continue;
    }

    const p = line.projection;
    const ecRate = ecRateOf(p);
    const callText =
      p.call.target !== null ? `Call ${p.call.actual}/${p.call.target} (${p.call.achievementPercentage}%)` : "Call: Data belum cukup";
    const ecText =
      p.effectiveCall.target !== null
        ? `EC ${p.effectiveCall.actual}/${p.effectiveCall.target} (${p.effectiveCall.achievementPercentage}%)`
        : "EC: Data belum cukup";

    lines.push(`${line.salesmanFullName}: ${callText}, ${ecText}, EC Rate ${ecRate !== null ? `${ecRate}%` : "Data belum cukup"}`);

    structuredSalesmen.push({
      salesmanFullName: line.salesmanFullName,
      call: p.call,
      effectiveCall: p.effectiveCall,
      ecRate,
      status: "TARGET_SET",
    });
  }

  return {
    text: lines.join("\n"),
    structured: {
      tenantName: ctx.tenantName,
      businessDate: ctx.businessDate,
      activePeriod: {
        id: ctx.activePeriod.id,
        name: ctx.activePeriod.name,
        startDate: ctx.activePeriod.startDate,
        endDate: ctx.activePeriod.endDate,
      },
      status: "ACTIVE_PERIOD",
      salesmen: structuredSalesmen,
    },
  };
}

export function kpiDailySummaryIdempotencyKey(companyId: string, businessDate: string): string {
  return `kpi_daily_summary:${companyId}:${businessDate}`;
}
