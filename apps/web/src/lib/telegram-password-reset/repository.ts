// =============================================================================
// Gate 3E-D2-B — Repository untuk self-service Telegram password reset.
// Implement TenantUserPasswordResetRepository (lib/tenant-user-password-
// reset/repository.ts) APA ADANYA -- resetTenantUserPassword() (workflow.ts,
// TIDAK diubah) jadi bisa dipakai ulang penuh, hanya RPC yang dipanggil
// beda (telegram_self_service_* alih-alih super_admin_*, migration
// 20260915000001). Pemanggil (webhook route) SELALU mengisi actorId sama
// dengan targetUserId (self-service) -- RPC menolak forbidden bila tidak.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasTelegramCapability } from "@/lib/telegram-enrollment/capability";
import type {
  TenantUserPasswordResetRepository,
  BeginResetResult,
  BeginResetFailureReason,
  UpdateAuthPasswordResult,
  FinalizeResetResult,
  FinalizeResetFailureReason,
} from "@/lib/tenant-user-password-reset/repository";

const KNOWN_BEGIN_FAILURES = [
  "target_not_found",
  "target_inactive",
  "target_role_not_resettable",
  "not_paired",
  "target_auth_missing",
  "already_in_progress",
  "forbidden",
];

const KNOWN_FINALIZE_FAILURES = ["forbidden", "operation_not_found", "invalid_state", "target_auth_missing"];

export class SupabaseTelegramSelfServicePasswordResetRepository
  implements TenantUserPasswordResetRepository
{
  constructor(private readonly supabase: SupabaseClient) {}

  /** Capability gate (Gate 3E-D1-R1 kontrak): dicek SEBELUM begin() dipanggil. */
  async hasPasswordResetCapability(userId: string, companyId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from("user_roles")
      .select("role:roles!role_id(name)")
      .eq("user_id", userId)
      .eq("company_id", companyId);

    const roles = ((data ?? []) as unknown as { role: { name: string } | null }[])
      .map((row) => row.role?.name)
      .filter((name): name is string => Boolean(name));

    return hasTelegramCapability(roles, "password.reset.self");
  }

  async beginReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<BeginResetResult> {
    const { data, error } = await this.supabase.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: input.operationId,
      p_actor_id: input.actorId,
      p_target_user_id: input.targetUserId,
    });

    if (error) return { ok: false, reason: "unexpected", message: error.message };

    const row = ((data ?? []) as { result_outcome: string; target_email: string | null; target_company_id: string | null }[])[0];
    if (!row) return { ok: false, reason: "unexpected", message: "empty RPC result" };

    if (row.result_outcome === "db_committed") {
      return { ok: true, targetEmail: row.target_email ?? "", targetCompanyId: row.target_company_id ?? "" };
    }

    if (KNOWN_BEGIN_FAILURES.includes(row.result_outcome)) {
      // "not_paired" bukan reason bawaan BeginResetFailureReason (union itu
      // ditulis untuk actor super_admin) -- dipetakan ke "target_not_found"
      // supaya tetap valid secara tipe TANPA membocorkan detail internal ke
      // caller; pesan asli tetap tersimpan di `message` untuk audit/log.
      const reason: BeginResetFailureReason =
        row.result_outcome === "not_paired"
          ? "target_not_found"
          : (row.result_outcome as BeginResetFailureReason);
      return { ok: false, reason, message: row.result_outcome };
    }

    return { ok: false, reason: "unexpected", message: `unknown outcome: ${row.result_outcome}` };
  }

  async updateAuthPassword(input: { targetUserId: string; newPassword: string }): Promise<UpdateAuthPasswordResult> {
    const { error } = await this.supabase.auth.admin.updateUserById(input.targetUserId, {
      password: input.newPassword,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  }

  async finalizeReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<FinalizeResetResult> {
    const { data, error } = await this.supabase.rpc("telegram_self_service_finalize_password_reset", {
      p_operation_id: input.operationId,
      p_actor_id: input.actorId,
      p_target_user_id: input.targetUserId,
    });

    if (error) return { ok: false, reason: "unexpected", message: error.message };

    const row = ((data ?? []) as { result_outcome: string }[])[0];
    if (!row) return { ok: false, reason: "unexpected", message: "empty RPC result" };

    if (row.result_outcome === "succeeded") return { ok: true };

    if (KNOWN_FINALIZE_FAILURES.includes(row.result_outcome)) {
      return {
        ok: false,
        reason: row.result_outcome as FinalizeResetFailureReason,
        message: row.result_outcome,
      };
    }

    return { ok: false, reason: "unexpected", message: `unknown outcome: ${row.result_outcome}` };
  }

  async failReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.supabase.rpc("telegram_self_service_fail_password_reset", {
        p_operation_id: input.operationId,
        p_actor_id: input.actorId,
        p_target_user_id: input.targetUserId,
        p_reason: input.reason,
      });
    } catch {
      // Best-effort -- identik alasan super_admin repository.
    }
  }
}

// -----------------------------------------------------------------------
// InMemory -- untuk unit test workflow.ts dengan aturan backstop self-
// service (bukan super_admin). Meniru RPC telegram_self_service_begin/
// finalize/fail_password_reset() (migration 20260915000001).
// -----------------------------------------------------------------------

export interface InMemoryTelegramUserRow {
  id: string;
  companyId: string;
  email: string;
  isActive: boolean;
  roles: string[];
  hasActiveTelegramPairing: boolean;
}

interface InMemoryOperation {
  targetUserId: string;
  status: "db_committed" | "succeeded" | "failed";
  failureReason?: string;
}

export class InMemoryTelegramSelfServicePasswordResetRepository
  implements TenantUserPasswordResetRepository
{
  private users = new Map<string, InMemoryTelegramUserRow>();
  private authHashes = new Map<string, string>();
  private mustChangePassword = new Map<string, boolean>();
  private baselineHash = new Map<string, string>();
  private inFlightTargets = new Set<string>();
  private operations = new Map<string, InMemoryOperation>();
  private auditTrail: { action: string; actorId: string; targetUserId: string; companyId: string }[] = [];

  failAuthUpdate = false;
  authUpdateCallCount = 0;

  seedUser(row: InMemoryTelegramUserRow, authHash = "hash-initial"): void {
    this.users.set(row.id, row);
    this.authHashes.set(row.id, authHash);
  }

  getMustChangePassword(id: string): boolean {
    return this.mustChangePassword.get(id) ?? false;
  }
  getBaselineHash(id: string): string | undefined {
    return this.baselineHash.get(id);
  }
  getAuthHash(id: string): string | undefined {
    return this.authHashes.get(id);
  }
  getAuditTrail() {
    return this.auditTrail;
  }
  isInFlight(targetUserId: string): boolean {
    return this.inFlightTargets.has(targetUserId);
  }

  async hasPasswordResetCapability(userId: string, _companyId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) return false;
    return hasTelegramCapability(user.roles, "password.reset.self");
  }

  async beginReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<BeginResetResult> {
    if (input.actorId !== input.targetUserId) {
      return { ok: false, reason: "forbidden", message: "forbidden" };
    }

    const target = this.users.get(input.targetUserId);
    if (!target) return { ok: false, reason: "target_not_found", message: "target_not_found" };
    if (!target.isActive) return { ok: false, reason: "target_inactive", message: "target_inactive" };
    if (!target.roles.some((r) => (["owner", "admin", "sales"] as string[]).includes(r))) {
      return { ok: false, reason: "target_role_not_resettable", message: "target_role_not_resettable" };
    }
    if (!target.hasActiveTelegramPairing) {
      return { ok: false, reason: "target_not_found", message: "not_paired" };
    }

    const preHash = this.authHashes.get(target.id);
    if (!preHash) return { ok: false, reason: "target_auth_missing", message: "target_auth_missing" };

    if (this.inFlightTargets.has(target.id)) {
      return { ok: false, reason: "already_in_progress", message: "already_in_progress" };
    }

    this.inFlightTargets.add(target.id);
    this.operations.set(input.operationId, { targetUserId: target.id, status: "db_committed" });
    this.mustChangePassword.set(target.id, true);
    this.baselineHash.set(target.id, preHash);
    this.auditTrail.push({
      action: "tenant_user.telegram_reset_started",
      actorId: input.actorId,
      targetUserId: target.id,
      companyId: target.companyId,
    });

    return { ok: true, targetEmail: target.email, targetCompanyId: target.companyId };
  }

  async updateAuthPassword(input: { targetUserId: string; newPassword: string }): Promise<UpdateAuthPasswordResult> {
    this.authUpdateCallCount += 1;
    if (this.failAuthUpdate) return { ok: false, message: "simulated auth failure" };
    this.authHashes.set(input.targetUserId, `hash-of:${input.newPassword}`);
    return { ok: true };
  }

  async finalizeReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<FinalizeResetResult> {
    if (input.actorId !== input.targetUserId) {
      return { ok: false, reason: "forbidden", message: "forbidden" };
    }

    const op = this.operations.get(input.operationId);
    if (!op) return { ok: false, reason: "operation_not_found", message: "operation_not_found" };
    if (op.status === "succeeded") return { ok: true };
    if (op.status !== "db_committed") return { ok: false, reason: "invalid_state", message: "invalid_state" };

    const newHash = this.authHashes.get(op.targetUserId);
    if (!newHash) return { ok: false, reason: "target_auth_missing", message: "target_auth_missing" };

    this.baselineHash.set(op.targetUserId, newHash);
    this.mustChangePassword.set(op.targetUserId, true);
    op.status = "succeeded";
    this.inFlightTargets.delete(op.targetUserId);
    this.auditTrail.push({
      action: "tenant_user.telegram_reset_completed",
      actorId: input.actorId,
      targetUserId: op.targetUserId,
      companyId: this.users.get(op.targetUserId)?.companyId ?? "",
    });

    return { ok: true };
  }

  async failReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
  }): Promise<void> {
    const op = this.operations.get(input.operationId);
    if (!op || op.status !== "db_committed") return;
    op.status = "failed";
    op.failureReason = input.reason;
    this.inFlightTargets.delete(op.targetUserId);
    this.auditTrail.push({
      action: "tenant_user.telegram_reset_failed",
      actorId: input.actorId,
      targetUserId: op.targetUserId,
      companyId: this.users.get(op.targetUserId)?.companyId ?? "",
    });
  }
}
