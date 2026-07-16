// =============================================================================
// Aturan murni (tanpa I/O) untuk scripts/reset-demo-access.ts — dipisah agar
// bisa diuji dengan vitest (folder scripts/ di root tidak tercakup oleh
// turbo test). Setiap fungsi di sini sengaja TIDAK PERNAH menerima/
// mengembalikan password di dalam pesan log, supaya tidak mungkin bocor
// lewat console — lihat reset-rules.test.ts.
// =============================================================================

export const DEMO_PROJECT_REF = "mcbwgvtkhykrrtvbpeys";

export type DemoAccount = "owner" | "sales";

export const DEMO_ALLOWED_EMAILS: Record<DemoAccount, string> = {
  owner: "owner.demo@waluyo.aodp.test",
  sales: "sales.demo@waluyo.aodp.test",
};

export function isValidDemoProjectHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return hostname.split(".")[0] === DEMO_PROJECT_REF;
}

export function isAllowedDemoEmail(account: DemoAccount, email: string | undefined | null): boolean {
  return email === DEMO_ALLOWED_EMAILS[account];
}

export function assertNewPasswordProvided(value: string | undefined | null): string {
  if (!value) {
    throw new Error("Password baru tidak tersedia di environment — reset dibatalkan (fail-closed).");
  }
  return value;
}

export function buildResetSuccessMessage(email: string, canonicalKey: string): string {
  return `SUKSES: password akun ${email} berhasil direset. Nilai baru tersimpan di ${canonicalKey} (tidak ditampilkan).`;
}

export function buildResetFailureMessage(reason: string): string {
  return `FAIL: ${reason}`;
}
