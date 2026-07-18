import type { SupabaseClient } from "@supabase/supabase-js";
import {
  WALUYO_SALES_KPI_DEFINITIONS,
  canTransitionSalesKpiPeriod,
  validateSalesKpiPeriodInput,
  validateSalesKpiTargetInput,
} from "./service";
import type {
  CreateSalesKpiPeriodInput,
  CreateSalesKpiPeriodResult,
  InitializeSalesKpiInput,
  InitializeSalesKpiResult,
  SalesKpiAuditEvent,
  SalesKpiDefinition,
  SalesKpiManagerRole,
  SalesKpiPeriod,
  SalesKpiPeriodStatus,
  SalesKpiTarget,
  SetSalesKpiPeriodStatusInput,
  SetSalesKpiPeriodStatusResult,
  SetSalesKpiTargetInput,
  SetSalesKpiTargetResult,
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

export class InMemorySalesKpiRepository implements SalesKpiRepository {
  private readonly actors = new Map<string, ActorSeed>();
  private readonly salespeople = new Map<string, SalespersonSeed>();
  private readonly definitions: SalesKpiDefinition[] = [];
  private readonly periods: SalesKpiPeriod[] = [];
  private readonly targets: SalesKpiTarget[] = [];
  private readonly auditTrail: SalesKpiAuditEvent[] = [];
  private sequence = 0;

  seedActor(
    actorId: string,
    companyId: string,
    role: ActorSeed["role"],
    active = true,
  ): void {
    this.actors.set(actorId, { companyId, role, active });
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
}
