import type { SupabaseClient } from "@supabase/supabase-js";

export type BeginResetFailureReason =
  | "forbidden"
  | "target_not_found"
  | "target_inactive"
  | "target_forbidden_super_admin"
  | "target_role_not_resettable"
  | "target_auth_missing"
  | "already_in_progress"
  | "unexpected";

export type BeginResetResult =
  | { ok: true; targetEmail: string; targetCompanyId: string }
  | { ok: false; reason: BeginResetFailureReason; message: string };

export type UpdateAuthPasswordResult = { ok: true } | { ok: false; message: string };

export type FinalizeResetFailureReason =
  | "forbidden"
  | "operation_not_found"
  | "invalid_state"
  | "target_auth_missing"
  | "unexpected";

export type FinalizeResetResult = { ok: true } | { ok: false; reason: FinalizeResetFailureReason; message: string };

export interface TenantUserPasswordResetRepository {
  /** Tahap DB pertama -- re-verifikasi actor+target, mengunci target fail-closed. */
  beginReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<BeginResetResult>;

  /** Tahap Auth API -- HANYA dipanggil setelah beginReset() sukses. */
  updateAuthPassword(input: { targetUserId: string; newPassword: string }): Promise<UpdateAuthPasswordResult>;

  /** Tahap DB kedua -- HANYA dipanggil setelah updateAuthPassword() sukses. */
  finalizeReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<FinalizeResetResult>;

  /**
   * Best-effort -- mencatat kegagalan tersanitasi. `reason` WAJIB string
   * statis (lihat workflow.ts), TIDAK PERNAH pesan error mentah/provider.
   */
  failReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
    reason: string;
  }): Promise<void>;
}

const KNOWN_BEGIN_FAILURES: BeginResetFailureReason[] = [
  "forbidden",
  "target_not_found",
  "target_inactive",
  "target_forbidden_super_admin",
  "target_role_not_resettable",
  "target_auth_missing",
  "already_in_progress",
];

const KNOWN_FINALIZE_FAILURES: FinalizeResetFailureReason[] = [
  "forbidden",
  "operation_not_found",
  "invalid_state",
  "target_auth_missing",
];

export class SupabaseTenantUserPasswordResetRepository implements TenantUserPasswordResetRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async beginReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<BeginResetResult> {
    const { data, error } = await this.supabase.rpc("super_admin_begin_tenant_user_password_reset", {
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

    if ((KNOWN_BEGIN_FAILURES as string[]).includes(row.result_outcome)) {
      return { ok: false, reason: row.result_outcome as BeginResetFailureReason, message: row.result_outcome };
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
    const { data, error } = await this.supabase.rpc("super_admin_finalize_tenant_user_password_reset", {
      p_operation_id: input.operationId,
      p_actor_id: input.actorId,
      p_target_user_id: input.targetUserId,
    });

    if (error) return { ok: false, reason: "unexpected", message: error.message };

    const row = ((data ?? []) as { result_outcome: string }[])[0];
    if (!row) return { ok: false, reason: "unexpected", message: "empty RPC result" };

    if (row.result_outcome === "succeeded") return { ok: true };

    if ((KNOWN_FINALIZE_FAILURES as string[]).includes(row.result_outcome)) {
      return { ok: false, reason: row.result_outcome as FinalizeResetFailureReason, message: row.result_outcome };
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
      await this.supabase.rpc("super_admin_fail_tenant_user_password_reset", {
        p_operation_id: input.operationId,
        p_actor_id: input.actorId,
        p_target_user_id: input.targetUserId,
        p_reason: input.reason,
      });
    } catch {
      // Best-effort -- kegagalan mencatat outcome gagal tidak boleh
      // menutupi/menggantikan outcome gagal asli yang sudah dikembalikan
      // ke caller.
    }
  }
}

// -----------------------------------------------------------------------
// InMemory -- untuk unit test. Meniru re-verifikasi actor/target dan lock
// fail-closed yang sungguhan dilakukan di dalam RPC (bukan hanya mempercayai
// bahwa caller/workflow.ts sudah memeriksa), plus idempotency/in-flight
// guard yang sungguhan datang dari partial unique index di Postgres.
// -----------------------------------------------------------------------

export interface InMemoryUserRow {
  id: string;
  companyId: string;
  email: string;
  isActive: boolean;
  roles: string[];
}

interface InMemoryOperation {
  targetUserId: string;
  status: "db_committed" | "succeeded" | "failed";
  failureReason?: string;
}

export class InMemoryTenantUserPasswordResetRepository implements TenantUserPasswordResetRepository {
  private users = new Map<string, InMemoryUserRow>();
  private authHashes = new Map<string, string>();
  private mustChangePassword = new Map<string, boolean>();
  private baselineHash = new Map<string, string>();
  private inFlightTargets = new Set<string>();
  private operations = new Map<string, InMemoryOperation>();
  private auditTrail: { action: string; actorId: string; targetUserId: string; companyId: string }[] = [];

  /** Set true untuk mensimulasikan auth.admin.updateUserById() gagal. */
  failAuthUpdate = false;
  /** Jumlah panggilan finalizeReset() awal yang akan gagal sebelum sukses. */
  finalizeFailuresRemaining = 0;

  authUpdateCallCount = 0;
  finalizeCallCount = 0;

  seedUser(row: InMemoryUserRow, authHash = "hash-initial"): void {
    this.users.set(row.id, row);
    this.authHashes.set(row.id, authHash);
  }

  /** Mensimulasikan target mengganti password sendiri (di luar alur reset ini). */
  setAuthHash(userId: string, hash: string): void {
    this.authHashes.set(userId, hash);
  }

  /** Mensimulasikan profil yatim -- public.users ada tapi auth.users tidak/rusak. */
  clearAuthHash(userId: string): void {
    this.authHashes.delete(userId);
  }

  getUser(id: string): InMemoryUserRow | undefined {
    return this.users.get(id);
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
  getOperation(operationId: string): InMemoryOperation | undefined {
    return this.operations.get(operationId);
  }
  isInFlight(targetUserId: string): boolean {
    return this.inFlightTargets.has(targetUserId);
  }

  async beginReset(input: {
    operationId: string;
    actorId: string;
    targetUserId: string;
  }): Promise<BeginResetResult> {
    const actor = this.users.get(input.actorId);
    if (!actor || !actor.isActive || !actor.roles.includes("super_admin")) {
      return { ok: false, reason: "forbidden", message: "forbidden" };
    }

    const target = this.users.get(input.targetUserId);
    if (!target) return { ok: false, reason: "target_not_found", message: "target_not_found" };
    if (!target.isActive) return { ok: false, reason: "target_inactive", message: "target_inactive" };
    if (target.roles.includes("super_admin")) {
      return { ok: false, reason: "target_forbidden_super_admin", message: "target_forbidden_super_admin" };
    }
    if (!target.roles.some((r) => (["owner", "admin", "sales"] as string[]).includes(r))) {
      return { ok: false, reason: "target_role_not_resettable", message: "target_role_not_resettable" };
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
      action: "tenant_user.password_reset_started",
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
    this.finalizeCallCount += 1;
    const op = this.operations.get(input.operationId);
    if (!op) return { ok: false, reason: "operation_not_found", message: "operation_not_found" };
    if (op.status === "succeeded") return { ok: true };
    if (op.status !== "db_committed") return { ok: false, reason: "invalid_state", message: "invalid_state" };

    if (this.finalizeFailuresRemaining > 0) {
      this.finalizeFailuresRemaining -= 1;
      return { ok: false, reason: "unexpected", message: "simulated finalize failure" };
    }

    const newHash = this.authHashes.get(op.targetUserId);
    if (!newHash) return { ok: false, reason: "target_auth_missing", message: "target_auth_missing" };

    this.baselineHash.set(op.targetUserId, newHash);
    this.mustChangePassword.set(op.targetUserId, true);
    op.status = "succeeded";
    this.inFlightTargets.delete(op.targetUserId);
    this.auditTrail.push({
      action: "tenant_user.password_reset_completed",
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
      action: "tenant_user.password_reset_failed",
      actorId: input.actorId,
      targetUserId: op.targetUserId,
      companyId: this.users.get(op.targetUserId)?.companyId ?? "",
    });
  }
}
