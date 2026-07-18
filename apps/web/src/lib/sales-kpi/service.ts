import {
  SALES_KPI_CODES,
  type CreateSalesKpiPeriodInput,
  type SalesKpiCode,
  type SalesKpiDefinition,
  type SalesKpiPeriodStatus,
  type SetSalesKpiTargetInput,
} from "./types";

export const WALUYO_SALES_KPI_DEFINITIONS: ReadonlyArray<
  Omit<SalesKpiDefinition, "id" | "companyId">
> = [
  {
    code: "CALL",
    name: "Call",
    description:
      "Kunjungan operasional valid Salesman ke toko assignment/coverage.",
    unit: "COUNT",
    measurementSource: "VALID_FIELD_VISIT",
    version: 1,
  },
  {
    code: "EFFECTIVE_CALL",
    name: "Effective Call",
    description:
      "Call valid yang menghasilkan Sales Order confirmed dengan order_source FIELD_VISIT.",
    unit: "COUNT",
    measurementSource: "CONFIRMED_FIELD_VISIT_ORDER",
    version: 1,
  },
] as const;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isSalesKpiCode(value: string): value is SalesKpiCode {
  return SALES_KPI_CODES.includes(value as SalesKpiCode);
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function inclusiveCalendarDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function validateSalesKpiPeriodInput(
  input: Pick<
    CreateSalesKpiPeriodInput,
    "name" | "startDate" | "endDate" | "workingDays"
  >,
): "invalid_name" | "invalid_date_range" | "invalid_working_days" | null {
  if (input.name.trim().length < 3) return "invalid_name";
  if (
    !isRealIsoDate(input.startDate) ||
    !isRealIsoDate(input.endDate) ||
    input.startDate > input.endDate
  ) {
    return "invalid_date_range";
  }
  const calendarDays = inclusiveCalendarDays(input.startDate, input.endDate);
  if (
    !Number.isInteger(input.workingDays) ||
    input.workingDays <= 0 ||
    input.workingDays > calendarDays
  ) {
    return "invalid_working_days";
  }
  return null;
}

export function validateSalesKpiTargetInput(
  input: Pick<
    SetSalesKpiTargetInput,
    "kpiCode" | "targetValue" | "changeReason"
  >,
): "unsupported_kpi" | "invalid_target" | "reason_required" | null {
  if (!isSalesKpiCode(input.kpiCode)) return "unsupported_kpi";
  if (!Number.isInteger(input.targetValue) || input.targetValue <= 0)
    return "invalid_target";
  if (input.changeReason.trim().length < 3) return "reason_required";
  return null;
}

export function canTransitionSalesKpiPeriod(
  current: SalesKpiPeriodStatus,
  next: SalesKpiPeriodStatus,
): boolean {
  return (
    current === next ||
    (current === "DRAFT" && next === "ACTIVE") ||
    (current === "ACTIVE" && next === "LOCKED")
  );
}
