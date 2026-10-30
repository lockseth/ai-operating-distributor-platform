// =============================================================================
// Kesehatan periode KPI -- complete_sales_visit hanya mengkredit CALL/EC bila
// ada periode ACTIVE yang mencakup tanggal bisnis hari ini (Asia/Jakarta).
// Tanpa periode itu kegagalannya diam-diam ("CALL 0"), jadi dihitung di sini
// supaya Owner dan Sales diberi peringatan eksplisit. Pure + satu fetcher.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";

export interface KpiPeriodRow {
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

export type KpiPeriodHealth =
  | { status: "ok"; periodName: string; endDate: string; daysLeft: number }
  | { status: "ending_soon"; periodName: string; endDate: string; daysLeft: number }
  | { status: "missing"; lastEndDate: string | null };

export const KPI_PERIOD_ENDING_SOON_DAYS = 3;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function evaluateKpiPeriodHealth(periods: KpiPeriodRow[], today: string): KpiPeriodHealth {
  const covering = periods.find((p) => p.status === "ACTIVE" && p.start_date <= today && today <= p.end_date);
  if (covering) {
    const daysLeft = daysBetween(today, covering.end_date);
    return {
      status: daysLeft <= KPI_PERIOD_ENDING_SOON_DAYS ? "ending_soon" : "ok",
      periodName: covering.name,
      endDate: covering.end_date,
      daysLeft,
    };
  }
  const lastEnd = periods.map((p) => p.end_date).sort().at(-1) ?? null;
  return { status: "missing", lastEndDate: lastEnd };
}

export async function getKpiPeriodHealth(
  client: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<KpiPeriodHealth | null> {
  const { data, error } = await client
    .from("sales_kpi_periods")
    .select("name, start_date, end_date, status")
    .eq("company_id", companyId);
  if (error) return null; // gagal baca = jangan menampilkan peringatan palsu
  return evaluateKpiPeriodHealth((data ?? []) as KpiPeriodRow[], businessDateJakarta(now));
}
