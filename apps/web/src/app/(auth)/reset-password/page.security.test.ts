// Gate 3E-C-C2-B4-R1 — source-contract test untuk /reset-password page.tsx,
// mirror pola app/(dashboard)/dashboard/users/new/page.security.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("/reset-password page contract (Gate 3E-C-C2-B4-R1)", () => {
  it("wajib memverifikasi session (getUser) sebelum merender form ganti password", () => {
    expect(page).toContain("supabase.auth.getUser()");
  });

  it("tanpa user -> redirect fail-closed, tidak merender ResetPasswordForm", () => {
    const start = page.indexOf("export default async function ResetPasswordPage");
    const body = page.slice(start);
    expect(body).toContain("if (!user)");
    const guardIdx = body.indexOf("if (!user)");
    const redirectIdx = body.indexOf("redirect(", guardIdx);
    const formIdx = body.indexOf("<ResetPasswordForm");
    expect(redirectIdx).toBeGreaterThan(guardIdx);
    expect(formIdx).toBeGreaterThan(redirectIdx);
  });

  it("redirect generik, tidak membocorkan detail internal Supabase", () => {
    expect(page).toContain('redirect("/login?error=recovery_failed")');
  });

  it("tidak menerima/membangun query token_hash sendiri -- verifikasi token sudah selesai di /auth/confirm", () => {
    expect(page).not.toContain("token_hash");
    expect(page).not.toContain(".auth.verifyOtp(");
  });
});
