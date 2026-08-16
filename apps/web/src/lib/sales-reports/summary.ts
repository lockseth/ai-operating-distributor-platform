// =============================================================================
// Sales Report — perhitungan performa (pure functions, tanpa I/O)
// =============================================================================

export interface ReportMetrics {
  target_oa: number;
  achieved_oa: number;
  target_revenue: number;
  achieved_revenue: number;
  remaining_working_days: number;
}

export interface PerformanceRow {
  salesperson_id: string;
  salesperson_name: string;
  report_count: number;
  target_oa: number;
  achieved_oa: number;
  target_revenue: number;
  achieved_revenue: number;
  gap_revenue: number;
  achievement_pct: number;
}

export function calcGap(target: number, achieved: number): number {
  return target - achieved;
}

export function calcAchievementPct(target: number, achieved: number): number {
  if (target <= 0) return achieved > 0 ? 100 : 0;
  return Math.round((achieved / target) * 100);
}

/**
 * Agregasi performa per salesperson dari kumpulan laporan harian
 * (dipakai untuk ringkasan bulanan + ranking sales).
 */
export function aggregatePerformance(
  reports: Array<ReportMetrics & { salesperson_id: string; salesperson_name: string }>
): PerformanceRow[] {
  const bySales = new Map<string, PerformanceRow>();

  for (const r of reports) {
    const row = bySales.get(r.salesperson_id) ?? {
      salesperson_id: r.salesperson_id,
      salesperson_name: r.salesperson_name,
      report_count: 0,
      target_oa: 0,
      achieved_oa: 0,
      target_revenue: 0,
      achieved_revenue: 0,
      gap_revenue: 0,
      achievement_pct: 0,
    };
    row.report_count      += 1;
    row.target_oa         += r.target_oa;
    row.achieved_oa       += r.achieved_oa;
    row.target_revenue    += r.target_revenue;
    row.achieved_revenue  += r.achieved_revenue;
    bySales.set(r.salesperson_id, row);
  }

  const rows = [...bySales.values()];
  for (const row of rows) {
    row.gap_revenue     = calcGap(row.target_revenue, row.achieved_revenue);
    row.achievement_pct = calcAchievementPct(row.target_revenue, row.achieved_revenue);
  }
  // Ranking: pencapaian omzet tertinggi dulu
  rows.sort((a, b) => b.achieved_revenue - a.achieved_revenue);
  return rows;
}

function formatIDR(n: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
}

export interface DailyReportSummaryInput {
  call: number;
  effectiveCall: number;
  orderCount: number;
  revenue: number;
  noo: number;
  remaining_working_days: number;
  area?: string | null;
}

/**
 * Placeholder AI summary — narasi deterministik dari ringkasan KPI harian
 * governed (Gate P4.03). Tidak lagi membingkai "target vs pencapaian" --
 * laporan harian tidak punya konsep target harian, cuma rekap apa yang
 * sungguhan terjadi. Akan diganti pemanggilan AI provider layer pada fase
 * berikutnya.
 */
export function buildAiSummaryPlaceholder(input: DailyReportSummaryInput): string {
  const parts: string[] = [];
  parts.push(
    `${input.effectiveCall} effective call dari ${input.call} kunjungan, menghasilkan ${input.orderCount} order senilai ${formatIDR(input.revenue)}.`
  );
  if (input.noo > 0) parts.push(`${input.noo} toko baru berhasil dibuka.`);
  if (input.area) parts.push(`Area kunjungan: ${input.area}.`);
  if (input.remaining_working_days > 0) parts.push(`Sisa ${input.remaining_working_days} hari kerja bulan ini.`);
  return parts.join(" ");
}
