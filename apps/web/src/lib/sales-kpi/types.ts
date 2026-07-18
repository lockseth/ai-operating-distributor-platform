export const SALES_KPI_CODES = ["CALL", "EFFECTIVE_CALL"] as const;

export type SalesKpiCode = (typeof SALES_KPI_CODES)[number];
export type SalesKpiMeasurementSource =
  | "VALID_FIELD_VISIT"
  | "CONFIRMED_FIELD_VISIT_ORDER";
export type SalesKpiPeriodStatus = "DRAFT" | "ACTIVE" | "LOCKED";
export type SalesKpiTargetStatus = "ACTIVE" | "SUPERSEDED";
export type SalesKpiManagerRole = "owner" | "manager" | "super_admin";

export interface SalesKpiDefinition {
  id: string;
  companyId: string;
  code: SalesKpiCode;
  name: string;
  description: string;
  unit: "COUNT";
  measurementSource: SalesKpiMeasurementSource;
  version: number;
}

export interface SalesKpiPeriod {
  id: string;
  companyId: string;
  name: string;
  startDate: string;
  endDate: string;
  workingDays: number;
  status: SalesKpiPeriodStatus;
}

export interface SalesKpiTarget {
  id: string;
  companyId: string;
  periodId: string;
  salespersonId: string;
  kpiCode: SalesKpiCode;
  targetValue: number;
  version: number;
  status: SalesKpiTargetStatus;
  previousTargetId: string | null;
  changeReason: string;
}

export interface InitializeSalesKpiInput {
  companyId: string;
  actorId: string;
}

export type InitializeSalesKpiResult =
  | { outcome: "initialized" | "already_initialized"; definitionCount: number }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };

export interface CreateSalesKpiPeriodInput {
  companyId: string;
  actorId: string;
  name: string;
  startDate: string;
  endDate: string;
  workingDays: number;
}

export type CreateSalesKpiPeriodResult =
  | { outcome: "created"; periodId: string }
  | {
      outcome:
        | "forbidden"
        | "invalid_name"
        | "invalid_date_range"
        | "invalid_working_days"
        | "overlapping_period";
    }
  | { outcome: "unexpected_error"; error: string };

export interface SetSalesKpiPeriodStatusInput {
  companyId: string;
  actorId: string;
  periodId: string;
  nextStatus: SalesKpiPeriodStatus;
}

export type SetSalesKpiPeriodStatusResult =
  | { outcome: "updated" | "already_status"; status: SalesKpiPeriodStatus }
  | {
      outcome: "forbidden" | "not_found" | "invalid_transition";
      status?: SalesKpiPeriodStatus;
    }
  | { outcome: "unexpected_error"; error: string };

export interface SetSalesKpiTargetInput {
  companyId: string;
  actorId: string;
  periodId: string;
  salespersonId: string;
  kpiCode: SalesKpiCode;
  targetValue: number;
  changeReason: string;
}

export type SetSalesKpiTargetResult =
  | {
      outcome: "created" | "updated" | "unchanged";
      targetId: string;
      version: number;
    }
  | {
      outcome:
        | "forbidden"
        | "unsupported_kpi"
        | "invalid_target"
        | "reason_required"
        | "period_not_found"
        | "period_locked"
        | "salesperson_not_eligible"
        | "foundation_not_initialized";
    }
  | { outcome: "unexpected_error"; error: string };

export interface SalesKpiAuditEvent {
  action: string;
  companyId: string;
  actorId: string;
  entityId: string | null;
  oldData: unknown;
  newData: unknown;
}

// =============================================================================
// Achievement Integration — Call & Effective Call. Achievement TIDAK PERNAH
// diinput/di-override manual: hanya lahir dari record_sales_call, dari
// trigger konfirmasi/pembatalan Sales Order, dan dari reverse_sales_call.
// =============================================================================

export type SalesCallTaskType = "REPEAT_VISIT" | "COVERAGE_EXCEPTION";
export type SalesCallCoverageBasis = "ASSIGNED" | "AREA" | "EXCEPTION";
export type SalesCallStatus = "VALID" | "REVERSED";
export type AchievementEventType = "CREDITED" | "REVERSED";
export type AchievementSourceType = "SALES_CALL" | "SALES_ORDER";

export interface CreateSalesCallTaskInput {
  companyId: string;
  actorId: string;
  salespersonId: string;
  customerId: string;
  taskType: SalesCallTaskType;
  validDate: string;
  reason: string;
}

export type CreateSalesCallTaskResult =
  | { outcome: "created"; taskId: string }
  | {
      outcome:
        | "forbidden"
        | "invalid_task_type"
        | "invalid_date"
        | "reason_required"
        | "salesperson_not_eligible"
        | "customer_not_found";
    }
  | { outcome: "unexpected_error"; error: string };

export interface RecordSalesCallInput {
  companyId: string;
  actorId: string;
  salespersonId: string;
  customerId: string;
  callDate: string;
  outcomeNotes: string;
  idempotencyKey: string;
  coverageExceptionTaskId?: string;
  repeatVisitTaskId?: string;
}

export type RecordSalesCallResult =
  | { outcome: "recorded" | "already_recorded"; callId: string }
  | {
      outcome:
        | "forbidden"
        | "invalid_input"
        | "invalid_date"
        | "outcome_required"
        | "idempotency_key_required"
        | "salesperson_not_eligible"
        | "customer_not_found"
        | "out_of_coverage"
        | "duplicate_same_day"
        | "invalid_authorization_task"
        | "authorization_task_already_used";
    }
  | { outcome: "unexpected_error"; error: string };

export interface LinkSalesOrderCallInput {
  companyId: string;
  actorId: string;
  orderId: string;
  callId: string;
}

export type LinkSalesOrderCallResult =
  | { outcome: "linked" }
  | {
      outcome:
        | "forbidden"
        | "order_not_found"
        | "already_linked"
        | "call_not_found"
        | "call_not_valid"
        | "customer_mismatch"
        | "salesperson_mismatch";
    }
  | { outcome: "unexpected_error"; error: string };

export interface ReverseSalesCallInput {
  companyId: string;
  actorId: string;
  callId: string;
  reason: string;
}

export type ReverseSalesCallResult =
  | { outcome: "reversed" | "already_reversed" }
  | { outcome: "forbidden" | "call_not_found" | "reason_required" }
  | { outcome: "unexpected_error"; error: string };

export type SalesKpiPacingStatus =
  | "NOT_STARTED"
  | "ON_TRACK"
  | "AHEAD"
  | "BEHIND"
  | "COMPLETE"
  | "DATA_INSUFFICIENT";

export interface SalesKpiAchievementLine {
  kpiCode: SalesKpiCode;
  /** null = "Data belum cukup" (belum ada target aktif untuk periode ini) */
  target: number | null;
  actual: number;
  remaining: number | null;
  achievementPercentage: number | null;
  pacingStatus: SalesKpiPacingStatus;
}

export interface SalesKpiAchievementProjection {
  companyId: string;
  salespersonId: string;
  periodId: string;
  periodName: string;
  startDate: string;
  endDate: string;
  call: SalesKpiAchievementLine;
  effectiveCall: SalesKpiAchievementLine;
  /** DATA_INSUFFICIENT hanya jika KEDUA target CALL dan EFFECTIVE_CALL belum dikonfigurasi. */
  sourceFreshness: "COMPLETE" | "DATA_INSUFFICIENT";
}

export interface GetSalesKpiAchievementProjectionInput {
  companyId: string;
  actorId: string;
  periodId: string;
  salespersonId: string;
}

export type GetSalesKpiAchievementProjectionResult =
  | { outcome: "ok"; projection: SalesKpiAchievementProjection }
  | { outcome: "forbidden" | "period_not_found" }
  | { outcome: "unexpected_error"; error: string };

// =============================================================================
// Owner KPI Setup & Target Calibration -- evidence historis (BUKAN prediksi
// AI/ML) untuk membantu Owner menetapkan target, plus setter gabungan
// Call+EC dengan aturan silang EC<=Call. Owner tetap pengambil keputusan
// final; sistem hanya menyajikan baseline.
// =============================================================================

export interface SalesKpiCalibrationBaseline {
  salespersonId: string;
  /** Rentang data historis yang dipakai sebagai evidence (SEBELUM period.startDate). */
  windowStartDate: string;
  windowEndDate: string;
  /** Jumlah hari kalender BERBEDA dengan Call valid tercatat dalam window -- dasar kecukupan data. */
  observedDays: number;
  historicalCall: number;
  historicalEffectiveCall: number;
  /** null jika historicalCall = 0 (hindari pembagian nol) -- EC Rate murni insight, bukan KPI. */
  ecRate: number | null;
  sufficiency: "SUFFICIENT" | "INSUFFICIENT";
}

export interface GetKpiCalibrationBaselineInput {
  companyId: string;
  actorId: string;
  periodId: string;
  salespersonId: string;
}

export type GetKpiCalibrationBaselineResult =
  | { outcome: "ok"; baseline: SalesKpiCalibrationBaseline }
  | { outcome: "forbidden" | "period_not_found" }
  | { outcome: "unexpected_error"; error: string };

export interface SetSalesKpiTargetsCalibratedInput {
  companyId: string;
  actorId: string;
  periodId: string;
  salespersonId: string;
  callTarget: number;
  ecTarget: number;
  changeReason: string;
}

export type SetSalesKpiTargetsCalibratedResult =
  | {
      outcome: "saved";
      callTargetId: string;
      callVersion: number;
      ecTargetId: string;
      ecVersion: number;
    }
  | {
      outcome:
        | "forbidden"
        | "invalid_call_target"
        | "invalid_ec_target"
        | "ec_exceeds_call"
        | "reason_required"
        | "period_not_found"
        | "period_locked"
        | "salesperson_not_eligible"
        | "foundation_not_initialized";
    }
  | { outcome: "unexpected_error"; error: string };
