import { createClient } from "@/lib/supabase/server";
import { computeAchievementLine } from "@/lib/sales-kpi/service";
import { SALES_KPI_CODES } from "@/lib/sales-kpi/types";
import type { SalesKpiAchievementLine, SalesKpiCode } from "@/lib/sales-kpi/types";

// =============================================================================
// Owner Dashboard -- drill-down performa sales PER SALESPERSON, governed (Gate
// Owner BI-C). Source of truth: sales_kpi_targets + sales_kpi_achievement_events
// pada periode KPI ACTIVE -- pola sama dengan agregat tenant-wide
// aggregateGovernedKpis (lib/executive/contributors/flowsales.ts, Gate Owner
// BI-B), bedanya di sini digroupkan per salesperson_id alih-alih dijumlah
// tenant-wide, dan achievement line per KPI dihitung lewat computeAchievementLine
// (lib/sales-kpi/service.ts) -- fungsi pure yang sama yang dipakai
// SupabaseSalesKpiRepository.getAchievementProjection untuk achievement view
// satu salesperson. sales_reports (self-report OA/omzet harian) TIDAK dipakai
// di sini -- lihat lock decision #2/#6 & komentar governed di flowsales.ts.
// =============================================================================

export interface OwnerSalesKpiPerformanceRow {
  salespersonId: string;
  salespersonName: string;
  call: SalesKpiAchievementLine;
  effectiveCall: SalesKpiAchievementLine;
  orderCount: SalesKpiAchievementLine;
  revenue: SalesKpiAchievementLine;
  noo: SalesKpiAchievementLine;
}

export interface OwnerSalesKpiPerformance {
  periodActive: boolean;
  periodId: string | null;
  periodName: string | null;
  startDate: string | null;
  endDate: string | null;
  rows: OwnerSalesKpiPerformanceRow[];
}

interface GovernedTargetRow {
  salesperson_id: string;
  target_value: number;
  kpi_definition: { code: SalesKpiCode } | { code: SalesKpiCode }[] | null;
}

interface GovernedEventRow {
  salesperson_id: string;
  kpi_code: SalesKpiCode;
  event_type: "CREDITED" | "REVERSED";
  value: number | string | null;
}

interface GovernedCodeAggregate {
  target: number;
  achieved: number;
  hasTarget: boolean;
}

type GovernedByCode = Record<SalesKpiCode, GovernedCodeAggregate>;

function emptyGovernedByCode(): GovernedByCode {
  return Object.fromEntries(
    SALES_KPI_CODES.map((code) => [code, { target: 0, achieved: 0, hasTarget: false }]),
  ) as GovernedByCode;
}

/**
 * Agregasi murni (tanpa I/O): baris sales_kpi_targets/sales_kpi_achievement_events
 * -> target/achieved/hasTarget per kode KPI, digroupkan per salesperson_id.
 * Analog dengan aggregateGovernedKpis (flowsales.ts, Gate Owner BI-B) yang
 * tenant-wide; di sini salesperson A tidak pernah menyumbang ke bucket
 * salesperson B karena setiap baris dikelompokkan lewat salesperson_id-nya
 * sendiri.
 */
export function aggregateGovernedKpisBySalesperson(
  targetRows: GovernedTargetRow[],
  eventRows: GovernedEventRow[],
): Map<string, GovernedByCode> {
  const bySalesperson = new Map<string, GovernedByCode>();

  function bucket(salespersonId: string): GovernedByCode {
    let existing = bySalesperson.get(salespersonId);
    if (!existing) {
      existing = emptyGovernedByCode();
      bySalesperson.set(salespersonId, existing);
    }
    return existing;
  }

  for (const row of targetRows) {
    const definition = Array.isArray(row.kpi_definition) ? row.kpi_definition[0] : row.kpi_definition;
    const code = definition?.code;
    if (!code || !SALES_KPI_CODES.includes(code)) continue;
    const b = bucket(row.salesperson_id);
    b[code].target += row.target_value;
    b[code].hasTarget = true;
  }

  for (const row of eventRows) {
    if (!SALES_KPI_CODES.includes(row.kpi_code)) continue;
    const b = bucket(row.salesperson_id);
    const sign = row.event_type === "CREDITED" ? 1 : -1;
    b[row.kpi_code].achieved += sign * Number(row.value ?? 0);
  }

  return bySalesperson;
}

function buildRow(
  salespersonId: string,
  salespersonName: string,
  byCode: GovernedByCode | undefined,
  period: { startDate: string; endDate: string },
): OwnerSalesKpiPerformanceRow {
  const targetFor = (code: SalesKpiCode) => (byCode?.[code]?.hasTarget ? byCode[code].target : null);
  const actualFor = (code: SalesKpiCode) => byCode?.[code]?.achieved ?? 0;

  return {
    salespersonId,
    salespersonName,
    call: computeAchievementLine("CALL", targetFor("CALL"), actualFor("CALL"), period),
    effectiveCall: computeAchievementLine(
      "EFFECTIVE_CALL",
      targetFor("EFFECTIVE_CALL"),
      actualFor("EFFECTIVE_CALL"),
      period,
    ),
    orderCount: computeAchievementLine("ORDER_COUNT", targetFor("ORDER_COUNT"), actualFor("ORDER_COUNT"), period),
    revenue: computeAchievementLine("REVENUE", targetFor("REVENUE"), actualFor("REVENUE"), period),
    noo: computeAchievementLine("NOO", targetFor("NOO"), actualFor("NOO"), period),
  };
}

export async function getOwnerSalesKpiPerformance(companyId: string): Promise<OwnerSalesKpiPerformance> {
  const supabase = await createClient();

  const [activePeriodRes, salesUsersRes] = await Promise.all([
    supabase
      .from("sales_kpi_periods")
      .select("id, name, start_date, end_date")
      .eq("company_id", companyId)
      .eq("status", "ACTIVE")
      .maybeSingle(),
    supabase
      .from("users")
      .select("id, full_name, user_roles!user_id(role:roles(name))")
      .eq("company_id", companyId)
      .eq("is_active", true),
  ]);

  const activePeriod = activePeriodRes.data as
    | { id: string; name: string; start_date: string; end_date: string }
    | null;

  const salesUsers = (
    (salesUsersRes.data ?? []) as unknown as {
      id: string;
      full_name: string;
      user_roles: { role: { name: string } | null }[];
    }[]
  ).filter((u) => u.user_roles?.some((ur) => ur.role?.name === "sales"));

  if (!activePeriod) {
    const fallbackPeriod = { startDate: "1970-01-01", endDate: "1970-01-01" };
    return {
      periodActive: false,
      periodId: null,
      periodName: null,
      startDate: null,
      endDate: null,
      rows: salesUsers.map((u) => buildRow(u.id, u.full_name, undefined, fallbackPeriod)),
    };
  }

  const period = { startDate: activePeriod.start_date, endDate: activePeriod.end_date };

  const [targetsRes, eventsRes] = await Promise.all([
    supabase
      .from("sales_kpi_targets")
      .select("salesperson_id, target_value, kpi_definition:sales_kpi_definitions(code)")
      .eq("company_id", companyId)
      .eq("period_id", activePeriod.id)
      .eq("status", "ACTIVE"),
    supabase
      .from("sales_kpi_achievement_events")
      .select("salesperson_id, kpi_code, event_type, value")
      .eq("company_id", companyId)
      .gte("business_date", activePeriod.start_date)
      .lte("business_date", activePeriod.end_date),
  ]);

  const bySalesperson = aggregateGovernedKpisBySalesperson(
    (targetsRes.data ?? []) as GovernedTargetRow[],
    (eventsRes.data ?? []) as GovernedEventRow[],
  );

  const rows = salesUsers
    .map((u) => buildRow(u.id, u.full_name, bySalesperson.get(u.id), period))
    .sort((a, b) => b.revenue.actual - a.revenue.actual);

  return {
    periodActive: true,
    periodId: activePeriod.id,
    periodName: activePeriod.name,
    startDate: activePeriod.start_date,
    endDate: activePeriod.end_date,
    rows,
  };
}
