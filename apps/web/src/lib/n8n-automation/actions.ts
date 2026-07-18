"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseAutomationRepository } from "./repository";
import type { AutomationJobStatus, AutomationOutboxListItem } from "./types";

const MANAGE_ROLES = ["owner", "manager", "super_admin"];

function canManageAutomation(user: { roles: string[] }): boolean {
  return hasRole(user.roles, MANAGE_ROLES);
}

export interface ListAutomationJobsResult {
  ok: boolean;
  jobs?: AutomationOutboxListItem[];
  error?: string;
}

export async function listAutomationJobsAction(
  statuses?: AutomationJobStatus[],
): Promise<ListAutomationJobsResult> {
  const user = await getAuthUser();
  if (user.isDemo) return { ok: false, error: "Automation tidak tersedia pada sesi demo." };
  if (!canManageAutomation(user)) {
    return { ok: false, error: "Tidak berwenang melihat automation job." };
  }

  const repository = new SupabaseAutomationRepository(getAdminClient());
  const jobs = await repository.listJobs(user.company_id, statuses);
  return { ok: true, jobs };
}

export interface ReplayAutomationJobActionResult {
  ok: boolean;
  outcome?: string;
  error?: string;
}

export async function replayAutomationJobAction(
  jobId: string,
  reason: string,
): Promise<ReplayAutomationJobActionResult> {
  const user = await getAuthUser();
  if (user.isDemo) return { ok: false, error: "Automation tidak tersedia pada sesi demo." };
  if (!canManageAutomation(user)) {
    return { ok: false, error: "Tidak berwenang melakukan replay." };
  }

  const repository = new SupabaseAutomationRepository(getAdminClient());
  const result = await repository.replayJob({
    companyId: user.company_id,
    actorId: user.id,
    credentialId: null,
    jobId,
    reason: reason.trim(),
  });

  if (result.outcome === "replayed") return { ok: true, outcome: result.outcome };
  if (result.outcome === "unexpected_error") {
    console.error("[Automation] replay failed", result.error);
  }
  const error =
    result.outcome === "invalid_state"
      ? "Job hanya bisa di-replay dari status DEAD_LETTER/FAILED."
      : result.outcome === "reason_required"
        ? "Alasan replay wajib diisi (minimal 3 karakter)."
        : result.outcome === "not_found"
          ? "Job tidak ditemukan."
          : "Gagal melakukan replay.";
  return { ok: false, outcome: result.outcome, error };
}
