import { randomUUID } from "node:crypto";
import { generateSecureTempPassword } from "../tenant-users/password";
import { isValidTargetUserId } from "./service";
import type { TenantUserPasswordResetRepository } from "./repository";
import type { ResetTenantUserPasswordInput, ResetTenantUserPasswordResult } from "./types";

const MAX_FINALIZE_ATTEMPTS = 3;

/**
 * Orkestrasi reset password super_admin -- Auth Admin API (GoTrue) dan
 * Postgres adalah DUA sistem terpisah, TIDAK ada satu transaksi ACID yang
 * mencakup keduanya (lihat header migration 20260913000001). Urutan WAJIB:
 *
 *   1. beginReset()        -- DB, mengunci target fail-closed
 *   2. updateAuthPassword() -- Auth API, HANYA jika (1) sukses
 *   3. finalizeReset()      -- DB, HANYA jika (2) sukses
 *
 * Kegagalan (1) TIDAK PERNAH memicu (2) -- "database-stage failure MUST
 * prevent Auth mutation" (kontrak gate). Kegagalan (2) memicu failReset()
 * (best-effort, tidak pernah menghapus lock fail-closed yang sudah diset
 * (1) -- lihat komentar migration). Kegagalan (3) SETELAH (2) sukses adalah
 * satu-satunya celah residual yang jujur didokumentasikan di sini: password
 * baru sudah live di Auth, tapi baseline DB gagal disegarkan. Di-retry
 * terbatas (MAX_FINALIZE_ATTEMPTS) karena kegagalan di titik ini murni
 * infrastruktur DB kita sendiri, bukan otorisasi (yang sudah lolos dan tidak
 * berubah). Jika retry habis, operasi dilaporkan GAGAL dan tempPassword
 * TIDAK PERNAH dikembalikan -- lebih aman kehilangan kredensial yang tidak
 * bisa dibuktikan konsisten daripada mengklaim sukses palsu.
 */
export async function resetTenantUserPassword(
  repo: TenantUserPasswordResetRepository,
  input: ResetTenantUserPasswordInput
): Promise<ResetTenantUserPasswordResult> {
  if (!isValidTargetUserId(input.targetUserId)) {
    return { outcome: "target_not_found" };
  }

  const operationId = randomUUID();

  const begin = await repo.beginReset({
    operationId,
    actorId: input.actorId,
    targetUserId: input.targetUserId,
  });

  if (!begin.ok) {
    if (begin.reason === "unexpected") return { outcome: "unexpected_error", error: begin.message };
    return { outcome: begin.reason };
  }

  // Dibuat SEKALI di sini, dipakai untuk updateAuthPassword di bawah, dan
  // dikembalikan tepat satu kali pada outcome "reset" -- tidak pernah
  // disimpan/di-log di tempat lain (lihat actions.ts).
  const tempPassword = generateSecureTempPassword();

  const authResult = await repo.updateAuthPassword({
    targetUserId: input.targetUserId,
    newPassword: tempPassword,
  });

  if (!authResult.ok) {
    // reason WAJIB string statis -- TIDAK PERNAH authResult.message (bisa
    // berasal dari provider Auth, tidak pernah dipercaya masuk audit trail
    // meski hanya berisi pesan validasi, bukan password itu sendiri).
    await repo.failReset({
      operationId,
      actorId: input.actorId,
      targetUserId: input.targetUserId,
      reason: "auth_update_failed",
    });
    return { outcome: "auth_update_failed" };
  }

  let finalized = false;
  for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS; attempt += 1) {
    const finalize = await repo.finalizeReset({
      operationId,
      actorId: input.actorId,
      targetUserId: input.targetUserId,
    });
    if (finalize.ok) {
      finalized = true;
      break;
    }
  }

  if (!finalized) {
    await repo.failReset({
      operationId,
      actorId: input.actorId,
      targetUserId: input.targetUserId,
      reason: "finalize_exhausted_retries",
    });
    return { outcome: "unexpected_error", error: "finalize_exhausted_retries" };
  }

  return {
    outcome: "reset",
    tempPassword,
    targetEmail: begin.targetEmail,
  };
}
