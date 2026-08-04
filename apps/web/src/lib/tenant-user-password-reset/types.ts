// =============================================================================
// super_admin Mereset Password User Tenant EXISTING -- Gate 3E-D2-A-R1.
//
// Domain otorisasi TERPISAH dari tenant-users/ (owner membuat user BARU,
// migration 20260911000001) -- di sini actor SELALU super_admin (operator
// platform, tidak tenant-scoped), target SELALU user yang SUDAH ADA. Input
// dari client dibatasi HANYA targetUserId (kontrak gate §3 "Input") -- tidak
// pernah password/role/company_id/email sebagai input otoritatif.
// =============================================================================

export type ResettableTargetRole = "owner" | "admin" | "sales";

export interface ResetTenantUserPasswordInput {
  actorId: string;
  targetUserId: string;
}

/**
 * Union outcome 1:1 dengan result_outcome RPC super_admin_begin_tenant_user_
 * password_reset() (migration 20260913000001) ditambah outcome tahap
 * Auth API/finalize di TS. tempPassword HANYA muncul pada outcome "reset",
 * tepat satu kali -- tidak pernah pada outcome lain manapun.
 */
export type ResetTenantUserPasswordResult =
  | { outcome: "reset"; tempPassword: string; targetEmail: string }
  | { outcome: "forbidden" }
  | { outcome: "target_not_found" }
  | { outcome: "target_inactive" }
  | { outcome: "target_forbidden_super_admin" }
  | { outcome: "target_role_not_resettable" }
  | { outcome: "target_auth_missing" }
  | { outcome: "already_in_progress" }
  | { outcome: "auth_update_failed" }
  | { outcome: "unexpected_error"; error: string };
