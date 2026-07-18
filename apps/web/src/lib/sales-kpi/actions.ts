"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseSalesKpiRepository } from "./repository";
import {
  isSalesKpiCode,
  validateCalibratedTargetsInput,
  validateSalesKpiPeriodInput,
  validateSalesKpiTargetInput,
} from "./service";
import type {
  SalesCallTaskType,
  SalesKpiAchievementProjection,
  SalesKpiCalibrationBaseline,
  SalesKpiPeriodStatus,
} from "./types";

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

function canRecordSalesCall(user: {
  roles: string[];
  permissions: string[];
}): boolean {
  return (
    hasPermission(user.permissions, "sales_kpi.record_call") ||
    canManageSalesKpi(user)
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

// =============================================================================
// Achievement Integration — Call & Effective Call. Achievement TIDAK PERNAH
// diinput/di-override manual lewat action ini: recordSalesCallAction hanya
// merekam KUNJUNGAN (Call itu sendiri), bukan angka achievement. Angka
// achievement selalu hasil turunan ledger (lihat getSalesKpiAchievementProjectionAction).
// =============================================================================

export interface CreateSalesCallTaskFormInput {
  salespersonId: string;
  customerId: string;
  taskType: SalesCallTaskType;
  validDate: string;
  reason: string;
}

export async function createSalesCallTaskAction(
  input: CreateSalesCallTaskFormInput,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;
  if (
    !UUID_PATTERN.test(input.salespersonId) ||
    !UUID_PATTERN.test(input.customerId)
  ) {
    return { ok: false, outcome: "invalid_input", error: "Input tidak valid." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.createCallTask({
    companyId: context.user.company_id,
    actorId: context.user.id,
    salespersonId: input.salespersonId,
    customerId: input.customerId,
    taskType: input.taskType,
    validDate: input.validDate,
    reason: input.reason.trim(),
  });

  if (result.outcome === "created") {
    return { ok: true, outcome: result.outcome, entityId: result.taskId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] create call task failed", result.error);
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: "Gagal membuat referensi exception Call.",
  };
}

export interface RecordSalesCallFormInput {
  salespersonId: string;
  customerId: string;
  callDate: string;
  outcomeNotes: string;
  idempotencyKey: string;
  coverageExceptionTaskId?: string;
  repeatVisitTaskId?: string;
}

export async function recordSalesCallAction(
  input: RecordSalesCallFormInput,
): Promise<SalesKpiActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Pencatatan Call tidak tersedia pada sesi demo." };
  }
  if (!canRecordSalesCall(user) && user.id !== input.salespersonId) {
    return { ok: false, error: "Tidak berwenang mencatat Call." };
  }
  if (
    !UUID_PATTERN.test(input.salespersonId) ||
    !UUID_PATTERN.test(input.customerId)
  ) {
    return { ok: false, outcome: "invalid_input", error: "Input tidak valid." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.recordCall({
    companyId: user.company_id,
    actorId: user.id,
    salespersonId: input.salespersonId,
    customerId: input.customerId,
    callDate: input.callDate,
    outcomeNotes: input.outcomeNotes.trim(),
    idempotencyKey: input.idempotencyKey,
    coverageExceptionTaskId: input.coverageExceptionTaskId,
    repeatVisitTaskId: input.repeatVisitTaskId,
  });

  if (result.outcome === "recorded" || result.outcome === "already_recorded") {
    return { ok: true, outcome: result.outcome, entityId: result.callId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] record call failed", result.error);
  }
  const error =
    result.outcome === "out_of_coverage"
      ? "Toko di luar area/assignment Salesman ini. Perlu approval exception."
      : result.outcome === "duplicate_same_day"
        ? "Kunjungan ke toko ini pada hari yang sama sudah tercatat."
        : result.outcome === "authorization_task_already_used"
          ? "Referensi exception ini sudah dipakai untuk kunjungan lain."
          : "Gagal mencatat Call.";
  return { ok: false, outcome: result.outcome, error };
}

export async function linkSalesOrderCallAction(
  orderId: string,
  callId: string,
): Promise<SalesKpiActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Penautan order-Call tidak tersedia pada sesi demo." };
  }
  if (!UUID_PATTERN.test(orderId) || !UUID_PATTERN.test(callId)) {
    return { ok: false, outcome: "invalid_input", error: "Input tidak valid." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.linkOrderCall({
    companyId: user.company_id,
    actorId: user.id,
    orderId,
    callId,
  });

  if (result.outcome === "linked") {
    return { ok: true, outcome: result.outcome, entityId: orderId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] link order call failed", result.error);
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: "Gagal menautkan order ke Call.",
  };
}

export async function reverseSalesCallAction(
  callId: string,
  reason: string,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;
  if (!UUID_PATTERN.test(callId)) {
    return { ok: false, outcome: "invalid_input", error: "Input tidak valid." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.reverseCall({
    companyId: context.user.company_id,
    actorId: context.user.id,
    callId,
    reason: reason.trim(),
  });

  if (result.outcome === "reversed" || result.outcome === "already_reversed") {
    return { ok: true, outcome: result.outcome, entityId: callId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] reverse call failed", result.error);
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: "Gagal membatalkan Call.",
  };
}

export interface SalesKpiAchievementActionResult {
  ok: boolean;
  projection?: SalesKpiAchievementProjection;
  error?: string;
}

export async function getSalesKpiAchievementProjectionAction(
  periodId: string,
  salespersonId: string,
): Promise<SalesKpiAchievementActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Achievement KPI tidak tersedia pada sesi demo." };
  }
  if (!UUID_PATTERN.test(periodId) || !UUID_PATTERN.test(salespersonId)) {
    return { ok: false, error: "Input tidak valid." };
  }
  if (user.id !== salespersonId && !canManageSalesKpi(user)) {
    return { ok: false, error: "Tidak berwenang melihat achievement KPI Salesman ini." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.getAchievementProjection({
    companyId: user.company_id,
    actorId: user.id,
    periodId,
    salespersonId,
  });

  if (result.outcome === "ok") {
    return { ok: true, projection: result.projection };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] get achievement projection failed", result.error);
  }
  return {
    ok: false,
    error:
      result.outcome === "period_not_found"
        ? "Periode KPI tidak ditemukan."
        : "Gagal memuat achievement KPI.",
  };
}

// =============================================================================
// Owner KPI Setup & Target Calibration.
// =============================================================================

export interface KpiCalibrationBaselineActionResult {
  ok: boolean;
  baseline?: SalesKpiCalibrationBaseline;
  error?: string;
}

export async function getKpiCalibrationBaselineAction(
  periodId: string,
  salespersonId: string,
): Promise<KpiCalibrationBaselineActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Kalibrasi KPI tidak tersedia pada sesi demo." };
  }
  if (!UUID_PATTERN.test(periodId) || !UUID_PATTERN.test(salespersonId)) {
    return { ok: false, error: "Input tidak valid." };
  }
  if (user.id !== salespersonId && !canManageSalesKpi(user)) {
    return { ok: false, error: "Tidak berwenang melihat baseline KPI Salesman ini." };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.getCalibrationBaseline({
    companyId: user.company_id,
    actorId: user.id,
    periodId,
    salespersonId,
  });

  if (result.outcome === "ok") {
    return { ok: true, baseline: result.baseline };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] get calibration baseline failed", result.error);
  }
  return {
    ok: false,
    error:
      result.outcome === "period_not_found"
        ? "Periode KPI tidak ditemukan."
        : "Gagal memuat baseline kalibrasi.",
  };
}

export interface SetSalesKpiTargetsCalibratedFormInput {
  periodId: string;
  salespersonId: string;
  callTarget: number;
  ecTarget: number;
  changeReason: string;
}

export async function setSalesKpiTargetsCalibratedAction(
  input: SetSalesKpiTargetsCalibratedFormInput,
): Promise<SalesKpiActionResult> {
  const context = await getAuthorizedContext();
  if (!context.ok) return context.result;
  if (
    !UUID_PATTERN.test(input.periodId) ||
    !UUID_PATTERN.test(input.salespersonId)
  ) {
    return { ok: false, outcome: "invalid_input", error: "Input tidak valid." };
  }

  const validation = validateCalibratedTargetsInput(input);
  if (validation) {
    const error =
      validation === "ec_exceeds_call"
        ? "Target Effective Call tidak boleh melebihi target Call."
        : validation === "reason_required"
          ? "Alasan perubahan wajib diisi (minimal 3 karakter)."
          : "Target tidak valid.";
    return { ok: false, outcome: validation, error };
  }

  const repository = new SupabaseSalesKpiRepository(getAdminClient());
  const result = await repository.setTargetsCalibrated({
    companyId: context.user.company_id,
    actorId: context.user.id,
    periodId: input.periodId,
    salespersonId: input.salespersonId,
    callTarget: input.callTarget,
    ecTarget: input.ecTarget,
    changeReason: input.changeReason.trim(),
  });

  if (result.outcome === "saved") {
    return { ok: true, outcome: result.outcome, entityId: result.callTargetId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesKpi] set calibrated targets failed", result.error);
  }
  const error =
    result.outcome === "ec_exceeds_call"
      ? "Target Effective Call tidak boleh melebihi target Call."
      : result.outcome === "period_locked"
        ? "Periode sudah dikunci; target tidak dapat diubah."
        : result.outcome === "salesperson_not_eligible"
          ? "Salesman tidak aktif atau bukan anggota tenant ini."
          : result.outcome === "reason_required"
            ? "Alasan perubahan wajib diisi."
            : "Gagal menyimpan target KPI.";
  return { ok: false, outcome: result.outcome, error };
}
