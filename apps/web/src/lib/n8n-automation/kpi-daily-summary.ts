// =============================================================================
// KPI Daily Summary -- presenter untuk Owner (WhatsApp channel, dry-run only
// pada phase ini -- lihat dispatch route, tidak pernah mengirim WhatsApp
// nyata). Konten SELALU dari data lib/sales-kpi/* per salesman, dirangkai
// di sini, tidak dihitung ulang.
// =============================================================================

import type { ActiveSalesKpiPeriod, SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";
import type { ChurnRiskLevel } from "@/lib/ai/features/churn-prediction";
import type { UnremittedCollectionRiskLevel } from "@/lib/business-guard/features/unremitted-collection";
import type { CallTimingRiskLevel } from "@/lib/business-guard/features/call-timing-anomaly";

export interface KpiDailySummarySalesmanLine {
  salesmanFullName: string;
  projection: SalesKpiAchievementProjection | null;
}

export interface KpiDailySummaryChurnCandidate {
  customerName: string;
  riskLevel: ChurnRiskLevel;
  daysSinceLastOrder: number;
}

export interface KpiDailySummaryUnremittedCandidate {
  collectorName: string;
  customerName: string;
  riskLevel: UnremittedCollectionRiskLevel;
  daysElapsed: number;
}

export interface KpiDailySummaryCallTimingCandidate {
  salespersonName: string;
  callDate: string;
  riskLevel: CallTimingRiskLevel;
  minGapSeconds: number | null;
  tightGapCount: number;
}

export interface KpiDailySummaryContext {
  tenantName: string;
  businessDate: string;
  activePeriod: ActiveSalesKpiPeriod | null;
  lines: KpiDailySummarySalesmanLine[];
  /**
   * Toko risiko churn HIGH/MEDIUM (lib/ai/features/churn-prediction.ts) --
   * opsional/null kalau pemanggil tidak menyediakan (skip bagian ini, bukan
   * error). Kosong (array 0 elemen) juga skip -- bagian ini HANYA muncul
   * kalau memang ada calon churn, konsisten pola PR Data Toko Kredit di
   * morning-brief.ts.
   */
  churnCandidates?: KpiDailySummaryChurnCandidate[] | null;
  /**
   * Klaim "sudah terima pembayaran" yang belum diformalkan jadi payment
   * claim resmi (Gate P4.18, lib/business-guard/features/unremitted-
   * collection.ts) -- HIGH/MEDIUM saja, pola opsional identik churnCandidates.
   */
  unremittedCandidates?: KpiDailySummaryUnremittedCandidate[] | null;
  /**
   * Hari kunjungan dengan jarak waktu antar-toko mencurigakan (Gate P4.19,
   * lib/business-guard/features/call-timing-anomaly.ts) -- BEDA dari
   * churnCandidates/unremittedCandidates: HANYA HIGH yang dikirim (bukan
   * HIGH+MEDIUM), karena sinyal ini heuristik berbasis aturan, bukan fakta
   * terkonfirmasi -- MEDIUM/LOW di sini artinya "layak dilihat", bukan
   * "anomali terkonfirmasi". Pola opsional identik 2 field lain.
   */
  callTimingCandidates?: KpiDailySummaryCallTimingCandidate[] | null;
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

/** Calon churn (HIGH/MEDIUM) -- HANYA muncul kalau ada, pola sama PR Data Toko Kredit di morning-brief.ts. */
function appendChurnLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.churnCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Calon Churn (${candidates.length} toko):`);
  for (const c of candidates) {
    const label = c.riskLevel === "HIGH" ? "Tinggi" : "Sedang";
    lines.push(`${c.customerName} -- risiko ${label}, tidak order ${c.daysSinceLastOrder} hari`);
  }
}

/** Klaim belum diformalkan (Gate P4.18, HIGH/MEDIUM) -- HANYA muncul kalau ada, pola sama appendChurnLines. */
function appendUnremittedLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.unremittedCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Klaim Pembayaran Belum Diformalkan (${candidates.length}):`);
  for (const c of candidates) {
    const label = c.riskLevel === "HIGH" ? "Tinggi" : "Sedang";
    lines.push(`${c.collectorName} -- ${c.customerName}, risiko ${label}, ${c.daysElapsed} hari belum ada klaim pembayaran`);
  }
}

/** Kunjungan mencurigakan (Gate P4.19, HIGH saja) -- HANYA muncul kalau ada, pola sama appendUnremittedLines. */
function appendCallTimingLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.callTimingCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Kunjungan Mencurigakan (${candidates.length}):`);
  for (const c of candidates) {
    const gapLabel = c.minGapSeconds !== null ? `${c.minGapSeconds} detik` : "-";
    lines.push(`${c.salespersonName} -- ${c.callDate}, jarak terketat ${gapLabel}, ${c.tightGapCount} pasang < 2 menit`);
  }
}

export function buildKpiDailySummary(ctx: KpiDailySummaryContext): KpiDailySummaryContent {
  const lines: string[] = [];
  lines.push(`${ctx.tenantName} -- KPI Daily Summary ${ctx.businessDate}`);
  lines.push("");

  if (!ctx.activePeriod) {
    lines.push("Periode KPI belum diaktifkan. Belum ada target resmi untuk ditampilkan.");
    appendChurnLines(lines, ctx);
    appendUnremittedLines(lines, ctx);
    appendCallTimingLines(lines, ctx);
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
        salesmen: [],
        churnCandidates: ctx.churnCandidates ?? [],
        unremittedCandidates: ctx.unremittedCandidates ?? [],
        callTimingCandidates: ctx.callTimingCandidates ?? [],
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

  appendChurnLines(lines, ctx);
  appendUnremittedLines(lines, ctx);
  appendCallTimingLines(lines, ctx);

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
      churnCandidates: ctx.churnCandidates ?? [],
      unremittedCandidates: ctx.unremittedCandidates ?? [],
      callTimingCandidates: ctx.callTimingCandidates ?? [],
    },
  };
}

export function kpiDailySummaryIdempotencyKey(companyId: string, businessDate: string): string {
  return `kpi_daily_summary:${companyId}:${businessDate}`;
}
