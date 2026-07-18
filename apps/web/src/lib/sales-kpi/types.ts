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
