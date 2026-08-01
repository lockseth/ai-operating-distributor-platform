// Gate 3D-B3-F1 — pure decision logic for the PKCE email-confirmation
// callback (/auth/callback). Kontrak sama dengan signup.ts: fungsi di sini
// TIDAK PERNAH memanggil Supabase/network -- hanya menentukan tujuan
// redirect yang aman setelah code exchange, supaya bisa diuji tanpa
// DB/browser.
//
// Satu-satunya continuation target yang di-allowlist untuk saat ini adalah
// /signup (layar "Lengkapi Pendaftaran"). Nilai `next` dari query string
// TIDAK PERNAH dipercaya langsung -- hanya dicocokkan PERSIS (exact string
// match) terhadap allowlist ini. Exact match berarti URL absolut
// (https://evil.com), protocol-relative (//evil.com), backslash bypass
// (/\evil.com, \\evil.com), maupun path internal lain yang belum diaudit
// otomatis gagal cocok dan fallback ke target default -- tidak pernah
// diikuti.

const ALLOWED_NEXT_PATHS: ReadonlySet<string> = new Set(["/signup"]);
const DEFAULT_NEXT_PATH = "/signup";

/**
 * Resolusi tujuan redirect setelah exchangeCodeForSession() berhasil.
 * Selalu mengembalikan path internal fixed dari allowlist -- tidak pernah
 * URL absolut, protocol-relative, atau path yang belum diaudit.
 */
export function resolveCallbackNextPath(next: string | null): string {
  if (next !== null && ALLOWED_NEXT_PATHS.has(next)) {
    return next;
  }
  return DEFAULT_NEXT_PATH;
}
