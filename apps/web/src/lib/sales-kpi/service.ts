import {
  SALES_KPI_CODES,
  type CreateSalesKpiPeriodInput,
  type SalesCallTaskType,
  type SalesKpiAchievementLine,
  type SalesKpiCode,
  type SalesKpiDefinition,
  type SalesKpiPacingStatus,
  type SalesKpiPeriodStatus,
  type SetSalesKpiTargetInput,
} from "./types";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";

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
  // Non-negatif (>=0) sejak 20260806000001 -- EC=0 sah untuk salesman
  // baru/toko yang belum pernah menghasilkan order confirmed.
  if (!Number.isInteger(input.targetValue) || input.targetValue < 0)
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

export function isSalesCallTaskType(
  value: string,
): value is SalesCallTaskType {
  return value === "REPEAT_VISIT" || value === "COVERAGE_EXCEPTION";
}

export function validateCreateSalesCallTaskInput(input: {
  taskType: string;
  validDate: string;
  reason: string;
}): "invalid_task_type" | "invalid_date" | "reason_required" | null {
  if (!isSalesCallTaskType(input.taskType)) return "invalid_task_type";
  if (!isRealIsoDate(input.validDate)) return "invalid_date";
  if (input.reason.trim().length < 3) return "reason_required";
  return null;
}

export function validateRecordSalesCallInput(input: {
  callDate: string;
  outcomeNotes: string;
  idempotencyKey: string;
  coverageExceptionTaskId?: string;
  repeatVisitTaskId?: string;
}): "invalid_input" | "invalid_date" | "outcome_required" | "idempotency_key_required" | null {
  if (input.coverageExceptionTaskId && input.repeatVisitTaskId) return "invalid_input";
  if (!isRealIsoDate(input.callDate)) return "invalid_date";
  if (input.outcomeNotes.trim().length < 3) return "outcome_required";
  if (input.idempotencyKey.trim().length === 0) return "idempotency_key_required";
  return null;
}

/**
 * "Hari ini" untuk perbandingan pacing -- SEKARANG business date Asia/Jakarta
 * (businessDateJakarta(), lib/n8n-automation/timezone.ts, helper authoritative
 * yang sudah dipakai Morning Brief). Sebelumnya memakai kalender UTC
 * (new Date().toISOString().slice(0,10)) -- limitation lama yang membuat
 * pacingStatus bisa "loncat hari" hingga 7 jam lebih awal/lambat dibanding
 * salesman sungguhan di Asia/Jakarta. sales_kpi_periods.start_date/end_date
 * sendiri TETAP string tanggal telanjang tanpa konversi TZ (tidak berubah)
 * -- yang berubah hanya titik referensi "hari ini" dipakai membandingkannya.
 */
export function todayIsoDate(): string {
  return businessDateJakarta();
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.floor(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000,
  );
}

export function computeAchievementLine(
  kpiCode: SalesKpiCode,
  target: number | null,
  actual: number,
  period: { startDate: string; endDate: string },
  today: string = todayIsoDate(),
): SalesKpiAchievementLine {
  if (target === null) {
    return {
      kpiCode,
      target: null,
      actual,
      remaining: null,
      achievementPercentage: null,
      pacingStatus: "DATA_INSUFFICIENT",
    };
  }

  const remaining = Math.max(0, target - actual);
  const achievementPercentage = Math.round((actual / target) * 100);

  let pacingStatus: SalesKpiPacingStatus;
  if (today < period.startDate) {
    pacingStatus = "NOT_STARTED";
  } else if (today > period.endDate) {
    pacingStatus = "COMPLETE";
  } else {
    const totalDays = daysBetween(period.startDate, period.endDate) + 1;
    const elapsedDays = daysBetween(period.startDate, today) + 1;
    const elapsedFraction = Math.min(1, Math.max(0, elapsedDays / totalDays));
    const expectedActual = target * elapsedFraction;
    if (actual >= expectedActual * 1.05) pacingStatus = "AHEAD";
    else if (actual < expectedActual * 0.95) pacingStatus = "BEHIND";
    else pacingStatus = "ON_TRACK";
  }

  return { kpiCode, target, actual, remaining, achievementPercentage, pacingStatus };
}

// =============================================================================
// Owner KPI Setup & Target Calibration.
// =============================================================================

/**
 * Jendela observasi baseline historis (hari kalender SEBELUM period.startDate).
 * Tidak ada aturan produk yang sudah ditetapkan untuk nilai ini (diverifikasi
 * eksplisit -- tidak ada dokumen "baseline"/"kalibrasi" untuk sales-kpi di
 * repo ini). Nilai default 90 hari dipilih sebagai perkiraan wajar (~1
 * kuartal) dan WAJIB dikonfirmasi eksplisit oleh Founder sebelum Production
 * Readiness -- lihat limitation di laporan akhir.
 */
export const KPI_BASELINE_LOOKBACK_DAYS = 90;

/**
 * Ambang minimal hari observasi (dengan Call valid tercatat) supaya baseline
 * dianggap layak dipakai kalibrasi. Sama seperti lookback window, ini adalah
 * default yang perlu konfirmasi Founder, bukan aturan produk yang sudah ada.
 */
export const KPI_BASELINE_MIN_OBSERVED_DAYS = 7;

export function computeCalibrationSufficiency(
  observedDays: number,
): "SUFFICIENT" | "INSUFFICIENT" {
  return observedDays >= KPI_BASELINE_MIN_OBSERVED_DAYS ? "SUFFICIENT" : "INSUFFICIENT";
}

export function computeEcRate(
  historicalCall: number,
  historicalEffectiveCall: number,
): number | null {
  if (historicalCall <= 0) return null;
  return Math.round((historicalEffectiveCall / historicalCall) * 100);
}

function addDaysIso(isoDate: string, deltaDays: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Jendela baseline: [periodStartDate - lookbackDays, periodStartDate - 1 hari]. */
export function calibrationBaselineWindow(
  periodStartDate: string,
  lookbackDays: number = KPI_BASELINE_LOOKBACK_DAYS,
): { windowStartDate: string; windowEndDate: string } {
  return {
    windowStartDate: addDaysIso(periodStartDate, -lookbackDays),
    windowEndDate: addDaysIso(periodStartDate, -1),
  };
}

export function validateCalibratedTargetsInput(input: {
  callTarget: number;
  ecTarget: number;
  changeReason: string;
}):
  | "invalid_call_target"
  | "invalid_ec_target"
  | "ec_exceeds_call"
  | "reason_required"
  | null {
  if (!Number.isInteger(input.callTarget) || input.callTarget < 0) {
    return "invalid_call_target";
  }
  if (!Number.isInteger(input.ecTarget) || input.ecTarget < 0) {
    return "invalid_ec_target";
  }
  if (input.ecTarget > input.callTarget) return "ec_exceeds_call";
  if (input.changeReason.trim().length < 3) return "reason_required";
  return null;
}
