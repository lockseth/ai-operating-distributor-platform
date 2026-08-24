"use server";

import { randomUUID } from "crypto";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseSalesVisitsRepository } from "./repository";
import {
  isValidLatitude,
  isValidLongitude,
  validateCompleteVisitInput,
  validateStartVisitInput,
} from "./service";
import type { SalesVisit, VisitActivity, VisitMetWith, VisitPurpose, VisitResult } from "./types";

const MANAGE_ROLES = ["owner", "manager", "super_admin"];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SalesVisitActionResult {
  ok: boolean;
  outcome?: string;
  visitId?: string;
  callCredited?: boolean;
  ecCredited?: boolean;
  error?: string;
}

const OUTCOME_MESSAGES: Record<string, string> = {
  forbidden: "Tidak berwenang melakukan tindakan ini.",
  invalid_purpose: "Tujuan kunjungan tidak valid.",
  invalid_location: "Lokasi GPS tidak valid atau belum diizinkan browser.",
  idempotency_key_required: "Permintaan tidak valid, silakan coba lagi.",
  customer_not_found: "Toko tidak ditemukan pada tenant ini.",
  visit_already_active: "Anda masih memiliki kunjungan yang sedang berjalan.",
  visit_not_found: "Kunjungan tidak ditemukan.",
  already_completed: "Kunjungan ini sudah diselesaikan sebelumnya.",
  invalid_result: "Hasil kunjungan tidak valid.",
  met_with_required: "Pihak yang ditemui wajib diisi bila hasilnya Bertemu pihak toko.",
  invalid_input: "Input tidak valid.",
  result_notes_required: "Catatan hasil wajib diisi (minimal 3 karakter).",
  follow_up_required: "Rencana dan tanggal tindak lanjut wajib diisi.",
  invalid_activity: "Aktivitas yang dipilih tidak valid.",
};

function errorMessage(outcome: string): string {
  return OUTCOME_MESSAGES[outcome] ?? "Gagal memproses kunjungan.";
}

export interface StartSalesVisitFormInput {
  customerId: string;
  visitPurpose: VisitPurpose;
  planNotes: string;
  startLatitude: number;
  startLongitude: number;
  /** Dibuat sekali di klien per percobaan submit -- retry request yang sama (double-click, koneksi putus) mengirim key yang SAMA supaya RPC mengembalikan hasil idempotent yang identik, bukan sekadar ditolak. */
  idempotencyKey?: string;
}

export async function startSalesVisitAction(
  input: StartSalesVisitFormInput,
): Promise<SalesVisitActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Kunjungan Sales tidak tersedia pada sesi demo." };
  }
  if (!hasRole(user.roles, "sales")) {
    return { ok: false, error: "Hanya role Sales yang dapat memulai kunjungan." };
  }
  if (!UUID_PATTERN.test(input.customerId)) {
    return { ok: false, outcome: "customer_not_found", error: "Toko tidak valid." };
  }

  const validation = validateStartVisitInput({
    customerId: input.customerId,
    visitPurpose: input.visitPurpose,
    planNotes: input.planNotes,
    startLatitude: input.startLatitude,
    startLongitude: input.startLongitude,
  });
  if (validation) {
    return { ok: false, outcome: validation, error: errorMessage(validation) };
  }

  const repository = new SupabaseSalesVisitsRepository(getAdminClient());
  const result = await repository.startVisit({
    companyId: user.company_id,
    actorId: user.id,
    customerId: input.customerId,
    visitPurpose: input.visitPurpose,
    planNotes: input.planNotes.trim() || null,
    startLatitude: input.startLatitude,
    startLongitude: input.startLongitude,
    idempotencyKey: `web-visit-start:${user.id}:${input.idempotencyKey ?? randomUUID()}`,
  });

  if (result.outcome === "started" || result.outcome === "already_started") {
    return { ok: true, outcome: result.outcome, visitId: result.visitId };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesVisits] start visit failed", result.error);
    return { ok: false, error: "Gagal memulai kunjungan." };
  }
  return { ok: false, outcome: result.outcome, error: errorMessage(result.outcome) };
}

export interface CompleteSalesVisitFormInput {
  visitId: string;
  visitResult: VisitResult;
  metWith: VisitMetWith | null;
  metPersonName: string;
  activities: VisitActivity[];
  resultNotes: string;
  followUpNeeded: boolean;
  followUpPlan: string;
  followUpDate: string;
  photoUrl: string;
  endLatitude: number;
  endLongitude: number;
  /** Dibuat sekali di klien per percobaan submit -- lihat catatan StartSalesVisitFormInput.idempotencyKey. */
  idempotencyKey?: string;
}

export async function completeSalesVisitAction(
  input: CompleteSalesVisitFormInput,
): Promise<SalesVisitActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Kunjungan Sales tidak tersedia pada sesi demo." };
  }
  if (!hasRole(user.roles, "sales")) {
    return { ok: false, error: "Hanya role Sales yang dapat menyelesaikan kunjungan." };
  }
  if (!UUID_PATTERN.test(input.visitId)) {
    return { ok: false, outcome: "visit_not_found", error: "Kunjungan tidak valid." };
  }

  const validation = validateCompleteVisitInput({
    visitResult: input.visitResult,
    metWith: input.metWith,
    activities: input.activities,
    resultNotes: input.resultNotes,
    followUpNeeded: input.followUpNeeded,
    followUpPlan: input.followUpPlan || null,
    followUpDate: input.followUpDate || null,
    endLatitude: input.endLatitude,
    endLongitude: input.endLongitude,
  });
  if (validation) {
    return { ok: false, outcome: validation, error: errorMessage(validation) };
  }
  if (
    !isValidLatitude(input.endLatitude) ||
    !isValidLongitude(input.endLongitude)
  ) {
    return { ok: false, outcome: "invalid_location", error: errorMessage("invalid_location") };
  }

  const repository = new SupabaseSalesVisitsRepository(getAdminClient());
  const result = await repository.completeVisit({
    companyId: user.company_id,
    actorId: user.id,
    visitId: input.visitId,
    visitResult: input.visitResult,
    metWith: input.visitResult === "MET_STORE" ? input.metWith : null,
    metPersonName: input.metPersonName.trim() || null,
    activities: input.activities,
    resultNotes: input.resultNotes.trim(),
    followUpNeeded: input.followUpNeeded,
    followUpPlan: input.followUpNeeded ? input.followUpPlan.trim() || null : null,
    followUpDate: input.followUpNeeded ? input.followUpDate || null : null,
    photoUrl: input.photoUrl.trim() || null,
    endLatitude: input.endLatitude,
    endLongitude: input.endLongitude,
    idempotencyKey: `web-visit-complete:${user.id}:${input.visitId}:${input.idempotencyKey ?? randomUUID()}`,
  });

  if (
    result.outcome === "completed" ||
    result.outcome === "already_recorded"
  ) {
    return {
      ok: true,
      outcome: result.outcome,
      visitId: result.visitId,
      callCredited: result.callCredited,
      ecCredited: result.ecCredited,
    };
  }
  if (
    result.outcome === "completed_cancelled" ||
    result.outcome === "completed_no_active_period" ||
    result.outcome === "completed_duplicate_call"
  ) {
    return { ok: true, outcome: result.outcome, visitId: result.visitId, callCredited: false, ecCredited: false };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[SalesVisits] complete visit failed", result.error);
    return { ok: false, error: "Gagal menyelesaikan kunjungan." };
  }
  return { ok: false, outcome: result.outcome, error: errorMessage(result.outcome) };
}

export interface SalesVisitDataResult {
  ok: boolean;
  activeVisit?: SalesVisit | null;
  history?: SalesVisit[];
  error?: string;
}

/** targetSalespersonId opsional -- hanya manager yang boleh melihat Sales lain. */
export async function getSalesVisitDataAction(
  targetSalespersonId?: string,
): Promise<SalesVisitDataResult> {
  const user = await getAuthUser();
  if (user.isDemo) {
    return { ok: false, error: "Kunjungan Sales tidak tersedia pada sesi demo." };
  }
  const canManage = hasRole(user.roles, MANAGE_ROLES);
  const isSales = hasRole(user.roles, "sales");
  if (!canManage && !isSales) {
    return { ok: false, error: "Tidak berwenang melihat Kunjungan Sales." };
  }

  let salespersonId = user.id;
  if (targetSalespersonId && targetSalespersonId !== user.id) {
    if (!canManage) {
      return { ok: false, error: "Tidak berwenang melihat kunjungan Sales lain." };
    }
    if (!UUID_PATTERN.test(targetSalespersonId)) {
      return { ok: false, error: "Input tidak valid." };
    }
    salespersonId = targetSalespersonId;
  } else if (!isSales && !targetSalespersonId) {
    return { ok: false, error: "Pilih Salesman terlebih dahulu." };
  }

  const repository = new SupabaseSalesVisitsRepository(getAdminClient());
  const [activeVisit, history] = await Promise.all([
    repository.getActiveVisit(user.company_id, salespersonId),
    repository.listVisits(user.company_id, salespersonId, 50),
  ]);

  return { ok: true, activeVisit, history };
}
