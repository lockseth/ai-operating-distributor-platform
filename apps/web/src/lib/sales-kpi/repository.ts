import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WALUYO_SALES_KPI_DEFINITIONS,
  calibrationBaselineWindow,
  canTransitionSalesKpiPeriod,
  computeAchievementLine,
  computeCalibrationSufficiency,
  computeEcRate,
  validateCalibratedTargetsInput,
  validateCreateSalesCallTaskInput,
  validateRecordSalesCallInput,
  validateSalesKpiPeriodInput,
  validateSalesKpiTargetInput,
} from "./service";
import type {
  ActiveSalesKpiPeriod,
  CreateSalesCallTaskInput,
  CreateSalesCallTaskResult,
  CreateSalesKpiPeriodInput,
  CreateSalesKpiPeriodResult,
  GetKpiCalibrationBaselineInput,
  GetKpiCalibrationBaselineResult,
  GetSalesKpiAchievementProjectionInput,
  GetSalesKpiAchievementProjectionResult,
  InitializeSalesKpiInput,
  InitializeSalesKpiResult,
  LinkSalesOrderCallInput,
  LinkSalesOrderCallResult,
  RecordSalesCallInput,
  RecordSalesCallResult,
  ReverseSalesCallInput,
  ReverseSalesCallResult,
  SalesCallCoverageBasis,
  SalesCallTaskType,
  SalesKpiAuditEvent,
  SalesKpiCode,
  SalesKpiDefinition,
  SalesKpiManagerRole,
  SalesKpiPeriod,
  SalesKpiPeriodStatus,
  SalesKpiTarget,
  SetSalesKpiPeriodStatusInput,
  SetSalesKpiPeriodStatusResult,
  SetSalesKpiTargetInput,
  SetSalesKpiTargetResult,
  SetSalesKpiTargetsCalibratedInput,
  SetSalesKpiTargetsCalibratedResult,
} from "./types";

export interface SalesKpiRepository {
  initializeFoundation(
    input: InitializeSalesKpiInput,
  ): Promise<InitializeSalesKpiResult>;
  createPeriod(
    input: CreateSalesKpiPeriodInput,
  ): Promise<CreateSalesKpiPeriodResult>;
  setPeriodStatus(
    input: SetSalesKpiPeriodStatusInput,
  ): Promise<SetSalesKpiPeriodStatusResult>;
  setTarget(input: SetSalesKpiTargetInput): Promise<SetSalesKpiTargetResult>;
  createCallTask(
    input: CreateSalesCallTaskInput,
  ): Promise<CreateSalesCallTaskResult>;
  recordCall(input: RecordSalesCallInput): Promise<RecordSalesCallResult>;
  linkOrderCall(
    input: LinkSalesOrderCallInput,
  ): Promise<LinkSalesOrderCallResult>;
  reverseCall(input: ReverseSalesCallInput): Promise<ReverseSalesCallResult>;
  getAchievementProjection(
    input: GetSalesKpiAchievementProjectionInput,
  ): Promise<GetSalesKpiAchievementProjectionResult>;
  getCalibrationBaseline(
    input: GetKpiCalibrationBaselineInput,
  ): Promise<GetKpiCalibrationBaselineResult>;
  setTargetsCalibrated(
    input: SetSalesKpiTargetsCalibratedInput,
  ): Promise<SetSalesKpiTargetsCalibratedResult>;
  /** Periode dengan status ACTIVE untuk company_id ini, atau null jika tidak ada. */
  findActivePeriod(companyId: string): Promise<ActiveSalesKpiPeriod | null>;
}

function firstRow<T>(data: unknown): T | null {
  return ((data ?? []) as T[])[0] ?? null;
}

export class SupabaseSalesKpiRepository implements SalesKpiRepository {
  constructor(private readonly client: SupabaseClient) {}

  async initializeFoundation(
    input: InitializeSalesKpiInput,
  ): Promise<InitializeSalesKpiResult> {
    const { data, error } = await this.client.rpc(
      "initialize_sales_kpi_foundation",
      {
        p_company_id: input.companyId,
        p_actor_id: input.actorId,
      },
    );
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string; definition_count: number }>(
      data,
    );
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "initialized" ||
      row.result_outcome === "already_initialized"
    ) {
      return {
        outcome: row.result_outcome,
        definitionCount: row.definition_count,
      };
    }
    if (row.result_outcome === "forbidden") return { outcome: "forbidden" };
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async createPeriod(
    input: CreateSalesKpiPeriodInput,
  ): Promise<CreateSalesKpiPeriodResult> {
    const { data, error } = await this.client.rpc("create_sales_kpi_period", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_name: input.name,
      p_start_date: input.startDate,
      p_end_date: input.endDate,
      p_working_days: input.workingDays,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_period_id: string | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (row.result_outcome === "created" && row.result_period_id) {
      return { outcome: "created", periodId: row.result_period_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_name" ||
      row.result_outcome === "invalid_date_range" ||
      row.result_outcome === "invalid_working_days" ||
      row.result_outcome === "overlapping_period"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async setPeriodStatus(
    input: SetSalesKpiPeriodStatusInput,
  ): Promise<SetSalesKpiPeriodStatusResult> {
    const { data, error } = await this.client.rpc(
      "set_sales_kpi_period_status",
      {
        p_company_id: input.companyId,
        p_actor_id: input.actorId,
        p_period_id: input.periodId,
        p_next_status: input.nextStatus,
      },
    );
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_status: string | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      (row.result_outcome === "updated" ||
        row.result_outcome === "already_status") &&
      row.result_status
    ) {
      return {
        outcome: row.result_outcome,
        status: row.result_status as SalesKpiPeriodStatus,
      };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "not_found" ||
      row.result_outcome === "invalid_transition"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async setTarget(
    input: SetSalesKpiTargetInput,
  ): Promise<SetSalesKpiTargetResult> {
    const { data, error } = await this.client.rpc("set_sales_kpi_target", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_period_id: input.periodId,
      p_salesperson_id: input.salespersonId,
      p_kpi_code: input.kpiCode,
      p_target_value: input.targetValue,
      p_change_reason: input.changeReason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_target_id: string | null;
      result_version: number | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      (row.result_outcome === "created" ||
        row.result_outcome === "updated" ||
        row.result_outcome === "unchanged") &&
      row.result_target_id &&
      row.result_version
    ) {
      return {
        outcome: row.result_outcome,
        targetId: row.result_target_id,
        version: row.result_version,
      };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "unsupported_kpi" ||
      row.result_outcome === "invalid_target" ||
      row.result_outcome === "reason_required" ||
      row.result_outcome === "period_not_found" ||
      row.result_outcome === "period_locked" ||
      row.result_outcome === "salesperson_not_eligible" ||
      row.result_outcome === "foundation_not_initialized"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async createCallTask(
    input: CreateSalesCallTaskInput,
  ): Promise<CreateSalesCallTaskResult> {
    const { data, error } = await this.client.rpc("create_sales_call_task", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_salesperson_id: input.salespersonId,
      p_customer_id: input.customerId,
      p_task_type: input.taskType,
      p_valid_date: input.validDate,
      p_reason: input.reason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_task_id: string | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (row.result_outcome === "created" && row.result_task_id) {
      return { outcome: "created", taskId: row.result_task_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_task_type" ||
      row.result_outcome === "invalid_date" ||
      row.result_outcome === "reason_required" ||
      row.result_outcome === "salesperson_not_eligible" ||
      row.result_outcome === "customer_not_found"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async recordCall(input: RecordSalesCallInput): Promise<RecordSalesCallResult> {
    const { data, error } = await this.client.rpc("record_sales_call", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_salesperson_id: input.salespersonId,
      p_customer_id: input.customerId,
      p_call_date: input.callDate,
      p_outcome_notes: input.outcomeNotes,
      p_idempotency_key: input.idempotencyKey,
      p_coverage_exception_task_id: input.coverageExceptionTaskId ?? null,
      p_repeat_visit_task_id: input.repeatVisitTaskId ?? null,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_call_id: string | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      (row.result_outcome === "recorded" ||
        row.result_outcome === "already_recorded") &&
      row.result_call_id
    ) {
      return { outcome: row.result_outcome, callId: row.result_call_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_input" ||
      row.result_outcome === "invalid_date" ||
      row.result_outcome === "outcome_required" ||
      row.result_outcome === "idempotency_key_required" ||
      row.result_outcome === "salesperson_not_eligible" ||
      row.result_outcome === "customer_not_found" ||
      row.result_outcome === "out_of_coverage" ||
      row.result_outcome === "duplicate_same_day" ||
      row.result_outcome === "invalid_authorization_task" ||
      row.result_outcome === "authorization_task_already_used"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async linkOrderCall(
    input: LinkSalesOrderCallInput,
  ): Promise<LinkSalesOrderCallResult> {
    const { data, error } = await this.client.rpc("link_sales_order_call", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_order_id: input.orderId,
      p_call_id: input.callId,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "linked" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "order_not_found" ||
      row.result_outcome === "already_linked" ||
      row.result_outcome === "call_not_found" ||
      row.result_outcome === "call_not_valid" ||
      row.result_outcome === "customer_mismatch" ||
      row.result_outcome === "salesperson_mismatch"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async reverseCall(
    input: ReverseSalesCallInput,
  ): Promise<ReverseSalesCallResult> {
    const { data, error } = await this.client.rpc("reverse_sales_call", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_call_id: input.callId,
      p_reason: input.reason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "reversed" ||
      row.result_outcome === "already_reversed" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "call_not_found" ||
      row.result_outcome === "reason_required"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async getAchievementProjection(
    input: GetSalesKpiAchievementProjectionInput,
  ): Promise<GetSalesKpiAchievementProjectionResult> {
    const { data: periodData, error: periodError } = await this.client
      .from("sales_kpi_periods")
      .select("id, name, start_date, end_date")
      .eq("id", input.periodId)
      .eq("company_id", input.companyId)
      .maybeSingle();
    if (periodError) {
      return { outcome: "unexpected_error", error: periodError.message };
    }
    if (!periodData) return { outcome: "period_not_found" };
    const period = periodData as {
      id: string;
      name: string;
      start_date: string;
      end_date: string;
    };

    const { data: targetRows, error: targetError } = await this.client
      .from("sales_kpi_targets")
      .select("target_value, kpi_definition:sales_kpi_definitions(code)")
      .eq("company_id", input.companyId)
      .eq("period_id", input.periodId)
      .eq("salesperson_id", input.salespersonId)
      .eq("status", "ACTIVE");
    if (targetError) {
      return { outcome: "unexpected_error", error: targetError.message };
    }
    const targets = new Map<SalesKpiCode, number>();
    for (const row of (targetRows ?? []) as {
      target_value: number;
      kpi_definition: { code: SalesKpiCode } | { code: SalesKpiCode }[] | null;
    }[]) {
      const definition = Array.isArray(row.kpi_definition)
        ? row.kpi_definition[0]
        : row.kpi_definition;
      if (definition?.code) targets.set(definition.code, row.target_value);
    }

    const { data: eventRows, error: eventError } = await this.client
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, value")
      .eq("company_id", input.companyId)
      .eq("salesperson_id", input.salespersonId)
      .gte("business_date", period.start_date)
      .lte("business_date", period.end_date);
    if (eventError) {
      return { outcome: "unexpected_error", error: eventError.message };
    }
    const actuals: Record<SalesKpiCode, number> = {
      CALL: 0,
      EFFECTIVE_CALL: 0,
      ORDER_COUNT: 0,
      REVENUE: 0,
      NOO: 0,
    };
    for (const row of (eventRows ?? []) as {
      kpi_code: SalesKpiCode;
      event_type: "CREDITED" | "REVERSED";
      value: number | string | null;
    }[]) {
      const magnitude = Number(row.value ?? 1);
      actuals[row.kpi_code] += (row.event_type === "CREDITED" ? 1 : -1) * magnitude;
    }

    const periodBounds = { startDate: period.start_date, endDate: period.end_date };
    const call = computeAchievementLine(
      "CALL",
      targets.get("CALL") ?? null,
      actuals.CALL,
      periodBounds,
    );
    const effectiveCall = computeAchievementLine(
      "EFFECTIVE_CALL",
      targets.get("EFFECTIVE_CALL") ?? null,
      actuals.EFFECTIVE_CALL,
      periodBounds,
    );
    const orderCount = computeAchievementLine(
      "ORDER_COUNT",
      targets.get("ORDER_COUNT") ?? null,
      actuals.ORDER_COUNT,
      periodBounds,
    );
    const revenue = computeAchievementLine(
      "REVENUE",
      targets.get("REVENUE") ?? null,
      actuals.REVENUE,
      periodBounds,
    );
    const noo = computeAchievementLine(
      "NOO",
      targets.get("NOO") ?? null,
      actuals.NOO,
      periodBounds,
    );

    return {
      outcome: "ok",
      projection: {
        companyId: input.companyId,
        salespersonId: input.salespersonId,
        periodId: period.id,
        periodName: period.name,
        startDate: period.start_date,
        endDate: period.end_date,
        call,
        effectiveCall,
        orderCount,
        revenue,
        noo,
        sourceFreshness:
          call.target === null &&
          effectiveCall.target === null &&
          orderCount.target === null &&
          revenue.target === null &&
          noo.target === null
            ? "DATA_INSUFFICIENT"
            : "COMPLETE",
      },
    };
  }

  async getCalibrationBaseline(
    input: GetKpiCalibrationBaselineInput,
  ): Promise<GetKpiCalibrationBaselineResult> {
    const { data: periodData, error: periodError } = await this.client
      .from("sales_kpi_periods")
      .select("id, start_date")
      .eq("id", input.periodId)
      .eq("company_id", input.companyId)
      .maybeSingle();
    if (periodError) {
      return { outcome: "unexpected_error", error: periodError.message };
    }
    if (!periodData) return { outcome: "period_not_found" };
    const period = periodData as { id: string; start_date: string };

    const { windowStartDate, windowEndDate } = calibrationBaselineWindow(
      period.start_date,
    );

    const { data: eventRows, error: eventError } = await this.client
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, business_date")
      .eq("company_id", input.companyId)
      .eq("salesperson_id", input.salespersonId)
      .gte("business_date", windowStartDate)
      .lte("business_date", windowEndDate);
    if (eventError) {
      return { outcome: "unexpected_error", error: eventError.message };
    }

    const rows = (eventRows ?? []) as {
      kpi_code: SalesKpiCode;
      event_type: "CREDITED" | "REVERSED";
      business_date: string;
    }[];

    let historicalCall = 0;
    let historicalEffectiveCall = 0;
    const callDays = new Set<string>();
    for (const row of rows) {
      const delta = row.event_type === "CREDITED" ? 1 : -1;
      if (row.kpi_code === "CALL") {
        historicalCall += delta;
        if (row.event_type === "CREDITED") callDays.add(row.business_date);
      } else {
        historicalEffectiveCall += delta;
      }
    }

    const observedDays = callDays.size;

    return {
      outcome: "ok",
      baseline: {
        salespersonId: input.salespersonId,
        windowStartDate,
        windowEndDate,
        observedDays,
        historicalCall,
        historicalEffectiveCall,
        ecRate: computeEcRate(historicalCall, historicalEffectiveCall),
        sufficiency: computeCalibrationSufficiency(observedDays),
      },
    };
  }

  async setTargetsCalibrated(
    input: SetSalesKpiTargetsCalibratedInput,
  ): Promise<SetSalesKpiTargetsCalibratedResult> {
    const { data, error } = await this.client.rpc(
      "set_sales_kpi_targets_calibrated",
      {
        p_company_id: input.companyId,
        p_actor_id: input.actorId,
        p_period_id: input.periodId,
        p_salesperson_id: input.salespersonId,
        p_call_target: input.callTarget,
        p_ec_target: input.ecTarget,
        p_change_reason: input.changeReason,
      },
    );
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      call_target_id: string | null;
      call_version: number | null;
      ec_target_id: string | null;
      ec_version: number | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    if (
      row.result_outcome === "saved" &&
      row.call_target_id &&
      row.call_version &&
      row.ec_target_id &&
      row.ec_version
    ) {
      return {
        outcome: "saved",
        callTargetId: row.call_target_id,
        callVersion: row.call_version,
        ecTargetId: row.ec_target_id,
        ecVersion: row.ec_version,
      };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_call_target" ||
      row.result_outcome === "invalid_ec_target" ||
      row.result_outcome === "ec_exceeds_call" ||
      row.result_outcome === "reason_required" ||
      row.result_outcome === "period_not_found" ||
      row.result_outcome === "period_locked" ||
      row.result_outcome === "salesperson_not_eligible" ||
      row.result_outcome === "foundation_not_initialized"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async findActivePeriod(companyId: string): Promise<ActiveSalesKpiPeriod | null> {
    const { data } = await this.client
      .from("sales_kpi_periods")
      .select("id, name, start_date, end_date")
      .eq("company_id", companyId)
      .eq("status", "ACTIVE")
      .maybeSingle();
    if (!data) return null;
    const row = data as { id: string; name: string; start_date: string; end_date: string };
    return { id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date };
  }
}

interface ActorSeed {
  companyId: string;
  role: SalesKpiManagerRole | "sales" | "admin";
  active: boolean;
}

interface SalespersonSeed {
  companyId: string;
  active: boolean;
}

interface CustomerSeed {
  companyId: string;
  area: string | null;
  assignedSalesId: string | null;
  active: boolean;
}

interface CoverageAreaSeed {
  companyId: string;
  salespersonId: string;
  area: string;
}

interface CallTaskRecord {
  id: string;
  companyId: string;
  salespersonId: string;
  customerId: string;
  taskType: SalesCallTaskType;
  validDate: string;
}

interface CallRecord {
  id: string;
  companyId: string;
  salespersonId: string;
  customerId: string;
  callDate: string;
  coverageBasis: SalesCallCoverageBasis;
  authorizationTaskId: string | null;
  idempotencyKey: string;
  status: "VALID" | "REVERSED";
}

interface OrderSeed {
  companyId: string;
  customerId: string;
  salesId: string | null;
  callId: string | null;
}

interface AchievementEventRecord {
  id: string;
  companyId: string;
  salespersonId: string;
  kpiCode: SalesKpiCode;
  eventType: "CREDITED" | "REVERSED";
  businessDate: string;
  callId: string | null;
  orderId: string | null;
  reversalOfEventId: string | null;
  /** Kontribusi numerik baris ini -- 1 untuk KPI COUNT, final_amount untuk REVENUE. */
  value: number;
}

export class InMemorySalesKpiRepository implements SalesKpiRepository {
  private readonly actors = new Map<string, ActorSeed>();
  private readonly salespeople = new Map<string, SalespersonSeed>();
  private readonly definitions: SalesKpiDefinition[] = [];
  private readonly periods: SalesKpiPeriod[] = [];
  private readonly targets: SalesKpiTarget[] = [];
  private readonly auditTrail: SalesKpiAuditEvent[] = [];
  private readonly customers = new Map<string, CustomerSeed>();
  private readonly coverageAreas: CoverageAreaSeed[] = [];
  private readonly callTasks: CallTaskRecord[] = [];
  private readonly calls: CallRecord[] = [];
  private readonly orders = new Map<string, OrderSeed>();
  private readonly achievementEvents: AchievementEventRecord[] = [];
  private sequence = 0;

  seedActor(
    actorId: string,
    companyId: string,
    role: ActorSeed["role"],
    active = true,
  ): void {
    this.actors.set(actorId, { companyId, role, active });
  }

  seedCustomer(
    customerId: string,
    companyId: string,
    opts: { area?: string | null; assignedSalesId?: string | null; active?: boolean } = {},
  ): void {
    this.customers.set(customerId, {
      companyId,
      area: opts.area ?? null,
      assignedSalesId: opts.assignedSalesId ?? null,
      active: opts.active ?? true,
    });
  }

  seedCoverageArea(companyId: string, salespersonId: string, area: string): void {
    this.coverageAreas.push({ companyId, salespersonId, area });
  }

  seedOrder(
    orderId: string,
    companyId: string,
    customerId: string,
    salesId: string | null,
  ): void {
    this.orders.set(orderId, { companyId, customerId, salesId, callId: null });
  }

  getCalls(companyId: string): CallRecord[] {
    return this.calls.filter((call) => call.companyId === companyId).map((row) => ({ ...row }));
  }

  getAchievementEvents(companyId: string): AchievementEventRecord[] {
    return this.achievementEvents
      .filter((event) => event.companyId === companyId)
      .map((row) => ({ ...row }));
  }

  /** Test-only: seed baris ledger historis langsung (mis. untuk uji baseline kalibrasi pra-periode, atau untuk uji agregasi ORDER_COUNT/REVENUE tanpa trigger Postgres). */
  seedAchievementEvent(
    companyId: string,
    salespersonId: string,
    kpiCode: SalesKpiCode,
    eventType: "CREDITED" | "REVERSED",
    businessDate: string,
    opts: { value?: number; orderId?: string | null } = {},
  ): void {
    this.achievementEvents.push({
      id: this.nextId("event"),
      companyId,
      salespersonId,
      kpiCode,
      eventType,
      businessDate,
      callId: null,
      orderId: opts.orderId ?? null,
      reversalOfEventId: null,
      value: opts.value ?? 1,
    });
  }

  seedSalesperson(
    salespersonId: string,
    companyId: string,
    active = true,
  ): void {
    this.salespeople.set(salespersonId, { companyId, active });
  }

  getDefinitions(companyId: string): SalesKpiDefinition[] {
    return this.definitions
      .filter((definition) => definition.companyId === companyId)
      .map((row) => ({ ...row }));
  }

  getPeriods(companyId: string): SalesKpiPeriod[] {
    return this.periods
      .filter((period) => period.companyId === companyId)
      .map((row) => ({ ...row }));
  }

  getTargets(companyId: string, salespersonId?: string): SalesKpiTarget[] {
    return this.targets
      .filter(
        (target) =>
          target.companyId === companyId &&
          (salespersonId === undefined ||
            target.salespersonId === salespersonId),
      )
      .map((row) => ({ ...row }));
  }

  getAuditTrail(companyId: string): SalesKpiAuditEvent[] {
    return this.auditTrail
      .filter((event) => event.companyId === companyId)
      .map((row) => ({ ...row }));
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private canManage(actorId: string, companyId: string): boolean {
    const actor = this.actors.get(actorId);
    return Boolean(
      actor?.active &&
      actor.companyId === companyId &&
      (actor.role === "owner" ||
        actor.role === "manager" ||
        actor.role === "super_admin"),
    );
  }

  async initializeFoundation(
    input: InitializeSalesKpiInput,
  ): Promise<InitializeSalesKpiResult> {
    if (!this.canManage(input.actorId, input.companyId))
      return { outcome: "forbidden" };

    const existingCodes = new Set(
      this.definitions
        .filter((definition) => definition.companyId === input.companyId)
        .map((definition) => definition.code),
    );
    let inserted = 0;
    for (const seed of WALUYO_SALES_KPI_DEFINITIONS) {
      if (existingCodes.has(seed.code)) continue;
      this.definitions.push({
        ...seed,
        id: this.nextId("definition"),
        companyId: input.companyId,
      });
      inserted += 1;
    }

    if (inserted > 0) {
      this.auditTrail.push({
        action: "sales_kpi.foundation_initialized",
        companyId: input.companyId,
        actorId: input.actorId,
        entityId: null,
        oldData: null,
        newData: {
          codes: ["CALL", "EFFECTIVE_CALL"],
          arIsKpi: false,
          weightedScoreEnabled: false,
        },
      });
    }

    return {
      outcome: inserted === 0 ? "already_initialized" : "initialized",
      definitionCount: this.getDefinitions(input.companyId).length,
    };
  }

  async createPeriod(
    input: CreateSalesKpiPeriodInput,
  ): Promise<CreateSalesKpiPeriodResult> {
    if (!this.canManage(input.actorId, input.companyId))
      return { outcome: "forbidden" };
    const validation = validateSalesKpiPeriodInput(input);
    if (validation) return { outcome: validation };

    const overlaps = this.periods.some(
      (period) =>
        period.companyId === input.companyId &&
        period.startDate <= input.endDate &&
        input.startDate <= period.endDate,
    );
    if (overlaps) return { outcome: "overlapping_period" };

    const period: SalesKpiPeriod = {
      id: this.nextId("period"),
      companyId: input.companyId,
      name: input.name.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      workingDays: input.workingDays,
      status: "DRAFT",
    };
    this.periods.push(period);
    this.auditTrail.push({
      action: "sales_kpi.period_created",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: period.id,
      oldData: null,
      newData: { ...period },
    });
    return { outcome: "created", periodId: period.id };
  }

  async setPeriodStatus(
    input: SetSalesKpiPeriodStatusInput,
  ): Promise<SetSalesKpiPeriodStatusResult> {
    if (!this.canManage(input.actorId, input.companyId))
      return { outcome: "forbidden" };
    const period = this.periods.find(
      (candidate) =>
        candidate.id === input.periodId &&
        candidate.companyId === input.companyId,
    );
    if (!period) return { outcome: "not_found" };
    if (period.status === input.nextStatus)
      return { outcome: "already_status", status: period.status };
    if (!canTransitionSalesKpiPeriod(period.status, input.nextStatus)) {
      return { outcome: "invalid_transition", status: period.status };
    }

    const previous = period.status;
    period.status = input.nextStatus;
    this.auditTrail.push({
      action: "sales_kpi.period_status_changed",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: period.id,
      oldData: { status: previous },
      newData: { status: period.status },
    });
    return { outcome: "updated", status: period.status };
  }

  async setTarget(
    input: SetSalesKpiTargetInput,
  ): Promise<SetSalesKpiTargetResult> {
    if (!this.canManage(input.actorId, input.companyId))
      return { outcome: "forbidden" };
    const validation = validateSalesKpiTargetInput(input);
    if (validation) return { outcome: validation };

    const period = this.periods.find(
      (candidate) =>
        candidate.id === input.periodId &&
        candidate.companyId === input.companyId,
    );
    if (!period) return { outcome: "period_not_found" };
    if (period.status === "LOCKED") return { outcome: "period_locked" };

    const salesperson = this.salespeople.get(input.salespersonId);
    if (!salesperson?.active || salesperson.companyId !== input.companyId) {
      return { outcome: "salesperson_not_eligible" };
    }

    const definition = this.definitions.find(
      (candidate) =>
        candidate.companyId === input.companyId &&
        candidate.code === input.kpiCode,
    );
    if (!definition) return { outcome: "foundation_not_initialized" };

    const current = this.targets.find(
      (target) =>
        target.companyId === input.companyId &&
        target.periodId === input.periodId &&
        target.salespersonId === input.salespersonId &&
        target.kpiCode === input.kpiCode &&
        target.status === "ACTIVE",
    );
    if (current?.targetValue === input.targetValue) {
      return {
        outcome: "unchanged",
        targetId: current.id,
        version: current.version,
      };
    }

    if (current) current.status = "SUPERSEDED";
    const target: SalesKpiTarget = {
      id: this.nextId("target"),
      companyId: input.companyId,
      periodId: input.periodId,
      salespersonId: input.salespersonId,
      kpiCode: input.kpiCode,
      targetValue: input.targetValue,
      version: (current?.version ?? 0) + 1,
      status: "ACTIVE",
      previousTargetId: current?.id ?? null,
      changeReason: input.changeReason.trim(),
    };
    this.targets.push(target);
    this.auditTrail.push({
      action: current ? "sales_kpi.target_revised" : "sales_kpi.target_created",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: target.id,
      oldData: current
        ? {
            targetId: current.id,
            targetValue: current.targetValue,
            version: current.version,
          }
        : null,
      newData: { ...target },
    });
    return {
      outcome: current ? "updated" : "created",
      targetId: target.id,
      version: target.version,
    };
  }

  async createCallTask(
    input: CreateSalesCallTaskInput,
  ): Promise<CreateSalesCallTaskResult> {
    if (!this.canManage(input.actorId, input.companyId)) {
      return { outcome: "forbidden" };
    }
    const validation = validateCreateSalesCallTaskInput(input);
    if (validation) return { outcome: validation };

    const salesperson = this.salespeople.get(input.salespersonId);
    if (!salesperson?.active || salesperson.companyId !== input.companyId) {
      return { outcome: "salesperson_not_eligible" };
    }
    const customer = this.customers.get(input.customerId);
    if (!customer?.active || customer.companyId !== input.companyId) {
      return { outcome: "customer_not_found" };
    }

    const taskId = this.nextId("call-task");
    this.callTasks.push({
      id: taskId,
      companyId: input.companyId,
      salespersonId: input.salespersonId,
      customerId: input.customerId,
      taskType: input.taskType,
      validDate: input.validDate,
    });
    return { outcome: "created", taskId };
  }

  async recordCall(input: RecordSalesCallInput): Promise<RecordSalesCallResult> {
    if (input.coverageExceptionTaskId && input.repeatVisitTaskId) {
      return { outcome: "invalid_input" };
    }
    const actor = this.actors.get(input.actorId);
    const actorAllowed = Boolean(
      actor?.active &&
        actor.companyId === input.companyId &&
        (input.actorId === input.salespersonId ||
          actor.role === "owner" ||
          actor.role === "manager" ||
          actor.role === "super_admin"),
    );
    if (!actorAllowed) return { outcome: "forbidden" };

    const validation = validateRecordSalesCallInput(input);
    if (validation) return { outcome: validation };

    const existing = this.calls.find(
      (call) =>
        call.companyId === input.companyId &&
        call.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { outcome: "already_recorded", callId: existing.id };

    const salesperson = this.salespeople.get(input.salespersonId);
    if (!salesperson?.active || salesperson.companyId !== input.companyId) {
      return { outcome: "salesperson_not_eligible" };
    }
    const customer = this.customers.get(input.customerId);
    if (!customer?.active || customer.companyId !== input.companyId) {
      return { outcome: "customer_not_found" };
    }

    let coverageBasis: "ASSIGNED" | "AREA" | "EXCEPTION" | null = null;
    if (customer.assignedSalesId === input.salespersonId) {
      coverageBasis = "ASSIGNED";
    } else if (
      customer.area &&
      this.coverageAreas.some(
        (entry) =>
          entry.companyId === input.companyId &&
          entry.salespersonId === input.salespersonId &&
          entry.area === customer.area,
      )
    ) {
      coverageBasis = "AREA";
    }

    let authorizationTaskId: string | null = null;

    if (!coverageBasis) {
      if (!input.coverageExceptionTaskId) return { outcome: "out_of_coverage" };
      const task = this.callTasks.find(
        (candidate) =>
          candidate.id === input.coverageExceptionTaskId &&
          candidate.companyId === input.companyId &&
          candidate.salespersonId === input.salespersonId &&
          candidate.customerId === input.customerId &&
          candidate.taskType === "COVERAGE_EXCEPTION" &&
          candidate.validDate === input.callDate,
      );
      if (!task) return { outcome: "invalid_authorization_task" };
      if (this.calls.some((call) => call.authorizationTaskId === task.id)) {
        return { outcome: "authorization_task_already_used" };
      }
      coverageBasis = "EXCEPTION";
      authorizationTaskId = task.id;
    } else if (input.repeatVisitTaskId) {
      const task = this.callTasks.find(
        (candidate) =>
          candidate.id === input.repeatVisitTaskId &&
          candidate.companyId === input.companyId &&
          candidate.salespersonId === input.salespersonId &&
          candidate.customerId === input.customerId &&
          candidate.taskType === "REPEAT_VISIT" &&
          candidate.validDate === input.callDate,
      );
      if (!task) return { outcome: "invalid_authorization_task" };
      if (this.calls.some((call) => call.authorizationTaskId === task.id)) {
        return { outcome: "authorization_task_already_used" };
      }
      authorizationTaskId = task.id;
    } else {
      const duplicate = this.calls.some(
        (call) =>
          call.companyId === input.companyId &&
          call.salespersonId === input.salespersonId &&
          call.customerId === input.customerId &&
          call.callDate === input.callDate &&
          call.status === "VALID" &&
          !call.authorizationTaskId,
      );
      if (duplicate) return { outcome: "duplicate_same_day" };
    }

    const callId = this.nextId("call");
    this.calls.push({
      id: callId,
      companyId: input.companyId,
      salespersonId: input.salespersonId,
      customerId: input.customerId,
      callDate: input.callDate,
      coverageBasis,
      authorizationTaskId,
      idempotencyKey: input.idempotencyKey,
      status: "VALID",
    });
    this.achievementEvents.push({
      id: this.nextId("event"),
      companyId: input.companyId,
      salespersonId: input.salespersonId,
      kpiCode: "CALL",
      eventType: "CREDITED",
      businessDate: input.callDate,
      callId,
      orderId: null,
      reversalOfEventId: null,
      value: 1,
    });
    return { outcome: "recorded", callId };
  }

  async linkOrderCall(
    input: LinkSalesOrderCallInput,
  ): Promise<LinkSalesOrderCallResult> {
    const order = this.orders.get(input.orderId);
    if (!order || order.companyId !== input.companyId) {
      return { outcome: "order_not_found" };
    }
    const actor = this.actors.get(input.actorId);
    const actorAllowed = Boolean(
      order.salesId === input.actorId ||
        (actor?.active &&
          actor.companyId === input.companyId &&
          (actor.role === "owner" ||
            actor.role === "manager" ||
            actor.role === "super_admin")),
    );
    if (!actorAllowed) return { outcome: "forbidden" };
    if (order.callId) return { outcome: "already_linked" };

    const call = this.calls.find(
      (candidate) =>
        candidate.id === input.callId && candidate.companyId === input.companyId,
    );
    if (!call) return { outcome: "call_not_found" };
    if (call.status !== "VALID") return { outcome: "call_not_valid" };
    if (call.customerId !== order.customerId) return { outcome: "customer_mismatch" };
    if (order.salesId !== call.salespersonId) {
      return { outcome: "salesperson_mismatch" };
    }

    order.callId = input.callId;
    return { outcome: "linked" };
  }

  async reverseCall(
    input: ReverseSalesCallInput,
  ): Promise<ReverseSalesCallResult> {
    if (!this.canManage(input.actorId, input.companyId)) {
      return { outcome: "forbidden" };
    }
    if (input.reason.trim().length < 3) return { outcome: "reason_required" };

    const call = this.calls.find(
      (candidate) =>
        candidate.id === input.callId && candidate.companyId === input.companyId,
    );
    if (!call) return { outcome: "call_not_found" };
    if (call.status === "REVERSED") return { outcome: "already_reversed" };

    call.status = "REVERSED";

    const callEvent = this.achievementEvents.find(
      (event) =>
        event.callId === call.id &&
        event.kpiCode === "CALL" &&
        event.eventType === "CREDITED",
    );
    if (callEvent) {
      this.achievementEvents.push({
        id: this.nextId("event"),
        companyId: callEvent.companyId,
        salespersonId: callEvent.salespersonId,
        kpiCode: "CALL",
        eventType: "REVERSED",
        businessDate: callEvent.businessDate,
        callId: call.id,
        orderId: null,
        reversalOfEventId: callEvent.id,
        value: 1,
      });
    }

    const ecEvent = this.achievementEvents.find(
      (event) =>
        event.callId === call.id &&
        event.kpiCode === "EFFECTIVE_CALL" &&
        event.eventType === "CREDITED",
    );
    if (ecEvent) {
      this.achievementEvents.push({
        id: this.nextId("event"),
        companyId: ecEvent.companyId,
        salespersonId: ecEvent.salespersonId,
        kpiCode: "EFFECTIVE_CALL",
        eventType: "REVERSED",
        businessDate: ecEvent.businessDate,
        callId: call.id,
        orderId: ecEvent.orderId,
        reversalOfEventId: ecEvent.id,
        value: 1,
      });
    }

    return { outcome: "reversed" };
  }

  async getAchievementProjection(
    input: GetSalesKpiAchievementProjectionInput,
  ): Promise<GetSalesKpiAchievementProjectionResult> {
    const period = this.periods.find(
      (candidate) =>
        candidate.id === input.periodId && candidate.companyId === input.companyId,
    );
    if (!period) return { outcome: "period_not_found" };

    const activeTargets = this.targets.filter(
      (target) =>
        target.companyId === input.companyId &&
        target.periodId === input.periodId &&
        target.salespersonId === input.salespersonId &&
        target.status === "ACTIVE",
    );
    const targetCall = activeTargets.find((t) => t.kpiCode === "CALL")?.targetValue ?? null;
    const targetEc =
      activeTargets.find((t) => t.kpiCode === "EFFECTIVE_CALL")?.targetValue ?? null;
    const targetOrderCount =
      activeTargets.find((t) => t.kpiCode === "ORDER_COUNT")?.targetValue ?? null;
    const targetRevenue =
      activeTargets.find((t) => t.kpiCode === "REVENUE")?.targetValue ?? null;
    const targetNoo = activeTargets.find((t) => t.kpiCode === "NOO")?.targetValue ?? null;

    const relevantEvents = this.achievementEvents.filter(
      (event) =>
        event.companyId === input.companyId &&
        event.salespersonId === input.salespersonId &&
        event.businessDate >= period.startDate &&
        event.businessDate <= period.endDate,
    );
    const actualFor = (kpiCode: SalesKpiCode): number =>
      relevantEvents
        .filter((event) => event.kpiCode === kpiCode)
        .reduce(
          (sum, event) => sum + (event.eventType === "CREDITED" ? 1 : -1) * event.value,
          0,
        );
    const actualCall = actualFor("CALL");
    const actualEc = actualFor("EFFECTIVE_CALL");
    const actualOrderCount = actualFor("ORDER_COUNT");
    const actualRevenue = actualFor("REVENUE");
    const actualNoo = actualFor("NOO");

    const periodBounds = { startDate: period.startDate, endDate: period.endDate };
    const call = computeAchievementLine("CALL", targetCall, actualCall, periodBounds);
    const effectiveCall = computeAchievementLine(
      "EFFECTIVE_CALL",
      targetEc,
      actualEc,
      periodBounds,
    );
    const orderCount = computeAchievementLine(
      "ORDER_COUNT",
      targetOrderCount,
      actualOrderCount,
      periodBounds,
    );
    const revenue = computeAchievementLine(
      "REVENUE",
      targetRevenue,
      actualRevenue,
      periodBounds,
    );
    const noo = computeAchievementLine("NOO", targetNoo, actualNoo, periodBounds);

    return {
      outcome: "ok",
      projection: {
        companyId: input.companyId,
        salespersonId: input.salespersonId,
        periodId: period.id,
        periodName: period.name,
        startDate: period.startDate,
        endDate: period.endDate,
        call,
        effectiveCall,
        orderCount,
        revenue,
        noo,
        sourceFreshness:
          call.target === null &&
          effectiveCall.target === null &&
          orderCount.target === null &&
          revenue.target === null &&
          noo.target === null
            ? "DATA_INSUFFICIENT"
            : "COMPLETE",
      },
    };
  }

  async getCalibrationBaseline(
    input: GetKpiCalibrationBaselineInput,
  ): Promise<GetKpiCalibrationBaselineResult> {
    const period = this.periods.find(
      (candidate) =>
        candidate.id === input.periodId && candidate.companyId === input.companyId,
    );
    if (!period) return { outcome: "period_not_found" };

    const { windowStartDate, windowEndDate } = calibrationBaselineWindow(
      period.startDate,
    );

    const relevantEvents = this.achievementEvents.filter(
      (event) =>
        event.companyId === input.companyId &&
        event.salespersonId === input.salespersonId &&
        event.businessDate >= windowStartDate &&
        event.businessDate <= windowEndDate,
    );

    let historicalCall = 0;
    let historicalEffectiveCall = 0;
    const callDays = new Set<string>();
    for (const event of relevantEvents) {
      const delta = event.eventType === "CREDITED" ? 1 : -1;
      if (event.kpiCode === "CALL") {
        historicalCall += delta;
        if (event.eventType === "CREDITED") callDays.add(event.businessDate);
      } else {
        historicalEffectiveCall += delta;
      }
    }

    const observedDays = callDays.size;

    return {
      outcome: "ok",
      baseline: {
        salespersonId: input.salespersonId,
        windowStartDate,
        windowEndDate,
        observedDays,
        historicalCall,
        historicalEffectiveCall,
        ecRate: computeEcRate(historicalCall, historicalEffectiveCall),
        sufficiency: computeCalibrationSufficiency(observedDays),
      },
    };
  }

  async setTargetsCalibrated(
    input: SetSalesKpiTargetsCalibratedInput,
  ): Promise<SetSalesKpiTargetsCalibratedResult> {
    if (!this.canManage(input.actorId, input.companyId)) {
      return { outcome: "forbidden" };
    }

    const validation = validateCalibratedTargetsInput(input);
    if (validation) return { outcome: validation };

    const callResult = await this.setTarget({
      companyId: input.companyId,
      actorId: input.actorId,
      periodId: input.periodId,
      salespersonId: input.salespersonId,
      kpiCode: "CALL",
      targetValue: input.callTarget,
      changeReason: input.changeReason,
    });
    if (
      callResult.outcome !== "created" &&
      callResult.outcome !== "updated" &&
      callResult.outcome !== "unchanged"
    ) {
      // unsupported_kpi/invalid_target/unexpected_error tidak pernah terjadi
      // di sini -- kpiCode literal "CALL" selalu didukung dan targetValue
      // sudah divalidasi validateCalibratedTargetsInput di atas.
      if (
        callResult.outcome === "forbidden" ||
        callResult.outcome === "period_not_found" ||
        callResult.outcome === "period_locked" ||
        callResult.outcome === "salesperson_not_eligible" ||
        callResult.outcome === "foundation_not_initialized"
      ) {
        return { outcome: callResult.outcome };
      }
      return { outcome: "invalid_call_target" };
    }

    const ecResult = await this.setTarget({
      companyId: input.companyId,
      actorId: input.actorId,
      periodId: input.periodId,
      salespersonId: input.salespersonId,
      kpiCode: "EFFECTIVE_CALL",
      targetValue: input.ecTarget,
      changeReason: input.changeReason,
    });
    if (
      ecResult.outcome !== "created" &&
      ecResult.outcome !== "updated" &&
      ecResult.outcome !== "unchanged"
    ) {
      if (
        ecResult.outcome === "forbidden" ||
        ecResult.outcome === "period_not_found" ||
        ecResult.outcome === "period_locked" ||
        ecResult.outcome === "salesperson_not_eligible" ||
        ecResult.outcome === "foundation_not_initialized"
      ) {
        return { outcome: ecResult.outcome };
      }
      return { outcome: "invalid_ec_target" };
    }

    return {
      outcome: "saved",
      callTargetId: callResult.targetId,
      callVersion: callResult.version,
      ecTargetId: ecResult.targetId,
      ecVersion: ecResult.version,
    };
  }

  async findActivePeriod(companyId: string): Promise<ActiveSalesKpiPeriod | null> {
    const period = this.periods.find(
      (candidate) => candidate.companyId === companyId && candidate.status === "ACTIVE",
    );
    return period
      ? { id: period.id, name: period.name, startDate: period.startDate, endDate: period.endDate }
      : null;
  }
}
