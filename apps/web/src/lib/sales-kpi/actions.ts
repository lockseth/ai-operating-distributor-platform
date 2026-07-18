"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseSalesKpiRepository } from "./repository";
import {
  isSalesKpiCode,
  validateSalesKpiPeriodInput,
  validateSalesKpiTargetInput,
} from "./service";
import type { SalesKpiPeriodStatus } from "./types";

const MANAGE_ROLES = ["owner", "manager", "super_admin"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canManageSalesKpi(user: {
  roles: string[];
  permissions: string[];
}): boolean {
  return (
    hasPermission(user.permissions, "sales_kpi.manage") ||
    MANAGE_ROLES.some((role) => user.roles.includes(role))
  );
}

export interface SalesKpiActionResult {
  ok: boolean;
  outcome?: string;
  entityId?: string;
  version?: number;
  error?: string;
}

async function getAuthorizedContext(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof getAuthUser>> }
  | { ok: false; result: SalesKpiActionResult }
> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "Konfigurasi KPI tidak tersedia pada sesi demo.",
      },
    };
  }
  if (!canManageSalesKpi(user)) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "Tidak berwenang mengubah konfigurasi KPI Salesman.",
      },
    };
  }
  return { ok: true, user };
}

export async function initializeSalesKpiFoundationAction(): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.initializeFoundation({
    companyId: context.user.company_id,
    actorId: context.user.id,
  });

  if (
    result.outcome === "initialized" ||
    result.outcome === "already_initialized"
  ) {
    return { ok: true, outcome: result.outcome };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] initialize foundation failed", result.error);
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: "Gagal menyiapkan fondasi KPI Salesman.",
  };
}

export interface CreateSalesKpiPeriodFormInput {
  name: string;
  startDate: string;
  endDate: string;
  workingDays: number;
}

export async function createSalesKpiPeriodAction(
  input: CreateSalesKpiPeriodFormInput,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;

  const validation = validateSalesKpiPeriodInput(input);
  if (validation)
    return {
      ok: false,
      outcome: validation,
      error: "Periode KPI tidak valid.",
    };

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.createPeriod({
    companyId: context.user.company_id,
    actorId: context.user.id,
    name: input.name.trim(),
    startDate: input.startDate,
    endDate: input.endDate,
    workingDays: input.workingDays,
  });

  if (result.outcome === "created") {
    return { ok: true, outcome: result.outcome, entityId: result.periodId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] create period failed", result.error);
  }
  const error =
    result.outcome === "overlapping_period"
      ? "Periode KPI bertumpuk dengan periode yang sudah ada."
      : "Gagal membuat periode KPI.";
  return { ok: false, outcome: result.outcome, error };
}

export async function setSalesKpiPeriodStatusAction(
  periodId: string,
  nextStatus: SalesKpiPeriodStatus,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;
  if (
    !UUID_PATTERN.test(periodId) ||
    !["ACTIVE", "LOCKED"].includes(nextStatus)
  ) {
    return {
      ok: false,
      outcome: "invalid_input",
      error: "Perubahan status periode tidak valid.",
    };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.setPeriodStatus({
    companyId: context.user.company_id,
    actorId: context.user.id,
    periodId,
    nextStatus,
  });

  if (result.outcome === "updated" || result.outcome === "already_status") {
    return { ok: true, outcome: result.outcome, entityId: periodId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] update period status failed", result.error);
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: "Gagal mengubah status periode KPI.",
  };
}

export interface SetSalesKpiTargetFormInput {
  periodId: string;
  salespersonId: string;
  kpiCode: string;
  targetValue: number;
  changeReason: string;
}

export async function setSalesKpiTargetAction(
  input: SetSalesKpiTargetFormInput,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;
  if (
    !UUID_PATTERN.test(input.periodId) ||
    !UUID_PATTERN.test(input.salespersonId) ||
    !isSalesKpiCode(input.kpiCode)
  ) {
    return {
      ok: false,
      outcome: "invalid_input",
      error: "Target KPI tidak valid.",
    };
  }

  const validation = validateSalesKpiTargetInput({
    kpiCode: input.kpiCode,
    targetValue: input.targetValue,
    changeReason: input.changeReason,
  });
  if (validation)
    return { ok: false, outcome: validation, error: "Target KPI tidak valid." };

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.setTarget({
    companyId: context.user.company_id,
    actorId: context.user.id,
    periodId: input.periodId,
    salespersonId: input.salespersonId,
    kpiCode: input.kpiCode,
    targetValue: input.targetValue,
    changeReason: input.changeReason.trim(),
  });

  if (
    result.outcome === "created" ||
    result.outcome === "updated" ||
    result.outcome === "unchanged"
  ) {
    return {
      ok: true,
      outcome: result.outcome,
      entityId: result.targetId,
      version: result.version,
    };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] set target failed", result.error);
  }
  const error =
    result.outcome === "period_locked"
      ? "Periode sudah dikunci; target tidak dapat diubah."
      : result.outcome === "salesperson_not_eligible"
        ? "Salesman tidak aktif atau bukan anggota tenant ini."
        : "Gagal menyimpan target KPI.";
  return { ok: false, outcome: result.outcome, error };
}
