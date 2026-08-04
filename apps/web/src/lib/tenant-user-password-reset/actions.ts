"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { getAdminClient } from "@/lib/supabase/admin";
import { resetTenantUserPassword } from "./workflow";
import { SupabaseTenantUserPasswordResetRepository } from "./repository";

export interface ResetTenantUserPasswordActionResult {
  ok: boolean;
  error?: string;
  /** Hanya terisi tepat satu kali pada response sukses -- lihat catatan di resetTenantUserPasswordAction. */
  tempPassword?: string;
  targetEmail?: string;
}

const OUTCOME_MESSAGE: Record<string, string> = {
  forbidden: "Anda tidak berwenang melakukan reset password ini.",
  target_not_found: "User tidak ditemukan.",
  target_inactive: "User tidak aktif.",
  target_forbidden_super_admin: "Password Super Admin tidak dapat direset lewat jalur ini.",
  target_role_not_resettable: "Role user ini tidak dapat direset lewat jalur ini.",
  target_auth_missing: "Data akun user tidak valid. Hubungi administrator sistem.",
  already_in_progress: "Reset password untuk user ini sedang diproses. Coba lagi sebentar.",
  auth_update_failed: "Gagal mengganti password. Coba lagi atau hubungi administrator sistem.",
};

/**
 * super_admin mereset password user tenant EXISTING (owner|admin|sales) --
 * domain otorisasi TERPISAH dari createTenantUserAction (owner-only, user
 * BARU, tenant-users/actions.ts). Hanya menerima targetUserId dari client
 * (kontrak gate §3) -- actorId SELALU dari sesi (getAuthUser()), tidak
 * pernah dari input, tidak pernah company_id/role client yang dipercaya
 * (keduanya di-resolve ULANG server-side lewat RPC, lihat migration
 * 20260913000001).
 */
export async function resetTenantUserPasswordAction(
  targetUserId: string
): Promise<ResetTenantUserPasswordActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Reset password tidak tersedia pada sesi demo." };
  }
  if (!user.roles.includes("super_admin")) {
    return { ok: false, error: OUTCOME_MESSAGE.forbidden };
  }

  const repo = new SupabaseTenantUserPasswordResetRepository(getAdminClient());
  const result = await resetTenantUserPassword(repo, {
    actorId: user.id,
    targetUserId,
  });

  if (result.outcome === "reset") {
    return { ok: true, tempPassword: result.tempPassword, targetEmail: result.targetEmail };
  }

  if (result.outcome === "unexpected_error") {
    // result.error SELALU string statis (mis. "finalize_exhausted_retries")
    // -- tidak pernah pesan provider mentah, tidak pernah password (lihat
    // workflow.ts) -- aman masuk log server.
    console.error("[TenantUserPasswordReset] failed", result.error);
    return { ok: false, error: "Gagal mereset password. Coba lagi atau hubungi administrator." };
  }

  return { ok: false, error: OUTCOME_MESSAGE[result.outcome] ?? "Gagal mereset password." };
}
