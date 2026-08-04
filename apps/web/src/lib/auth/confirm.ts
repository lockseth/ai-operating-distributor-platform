// Gate 3E-C-C2-B4-R1 — pure decision logic for the token_hash-based recovery
// confirmation callback (/auth/confirm). Kontrak sama dengan lib/auth/
// callback.ts: fungsi di sini TIDAK PERNAH memanggil Supabase/network --
// hanya menentukan tujuan redirect yang aman setelah verifyOtp() berhasil,
// supaya bisa diuji tanpa DB/browser.
//
// Satu-satunya continuation target yang di-allowlist untuk saat ini adalah
// /reset-password -- rute ini scoped khusus type=recovery (lihat route.ts),
// jadi hanya ada satu tujuan sah. Nilai `next` dari query string TIDAK
// PERNAH dipercaya langsung -- hanya dicocokkan PERSIS (exact string match)
// terhadap allowlist ini, identik resolveCallbackNextPath.

const ALLOWED_NEXT_PATHS: ReadonlySet<string> = new Set(["/reset-password"]);
const DEFAULT_NEXT_PATH = "/reset-password";

/**
 * Resolusi tujuan redirect setelah verifyOtp({ type: "recovery" }) berhasil.
 * Selalu mengembalikan path internal fixed dari allowlist -- tidak pernah
 * URL absolut, protocol-relative, atau path yang belum diaudit.
 */
export function resolveConfirmNextPath(next: string | null): string {
  if (next !== null && ALLOWED_NEXT_PATHS.has(next)) {
    return next;
  }
  return DEFAULT_NEXT_PATH;
}
