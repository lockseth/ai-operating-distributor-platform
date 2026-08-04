// =============================================================================
// Validasi murni (tanpa I/O) untuk input reset password super_admin.
// Pola identik tenant-users/service.ts.
// =============================================================================

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bentuk saja -- BUKAN pengganti verifikasi keberadaan/kelayakan target,
 * yang selalu re-dicek di dalam RPC super_admin_begin_tenant_user_password_
 * reset() (database sebagai authorization backstop). Ini hanya penyaring
 * awal supaya input yang jelas bukan UUID tidak perlu bulat-bulat sampai ke
 * database.
 */
export function isValidTargetUserId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}
