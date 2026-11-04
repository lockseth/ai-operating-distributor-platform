// Gate 3E-C-C2-B4-R1 — source-contract test untuk forgot-password-form.tsx,
// diperluas oleh Gate 3E-D2-A-R3 (OTP manual menggantikan magic-link sebagai
// jalur utama -- lihat komentar di source: PKCE code_verifier per-browser
// bikin magic-link gagal setiap kali link dibuka dari device berbeda dari
// yang memicu resetPasswordForEmail(), sedangkan verifyOtp({email,token})
// tidak bergantung sama sekali pada code_verifier).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "forgot-password-form.tsx"), "utf8");

describe("forgot-password-form security contract (Gate 3E-C-C2-B4-R1)", () => {
  it("redirectTo fixed same-origin ke /reset-password (tujuan produksi canonical), tidak dari query/input", () => {
    expect(source).toContain("redirectTo: `${window.location.origin}/reset-password`");
  });

  it("email diambil dari input form sendiri, bukan dari query string", () => {
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("useSearchParams");
  });

  it("email/OTP tidak pernah di-log", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});

describe("forgot-password-form OTP recovery contract (Gate 3E-D2-A-R3)", () => {
  it("verifyOtp dipanggil dengan type recovery, bukan signup/email_change/dst", () => {
    expect(source).toContain("supabase.auth.verifyOtp({");
    expect(source).toContain('type: "recovery"');
  });

  it("kegagalan verifyOtp TIDAK PERNAH lanjut ke RPC atau router.push -- fail-closed", () => {
    const start = source.indexOf("async function handleVerifyOtp");
    const body = source.slice(start);
    const errIdx = body.indexOf("if (verifyError)");
    expect(errIdx).toBeGreaterThan(-1);
    const returnIdx = body.indexOf("return;", errIdx);
    const rpcIdx = body.indexOf('supabase.rpc("begin_self_recovery_password_change")');
    const pushIdx = body.indexOf('router.push("/dashboard")');
    expect(returnIdx).toBeGreaterThan(errIdx);
    expect(rpcIdx).toBeGreaterThan(returnIdx);
    expect(pushIdx).toBeGreaterThan(rpcIdx);
  });

  it("begin_self_recovery_password_change() dipanggil SETELAH verifyOtp sukses, SEBELUM redirect dashboard", () => {
    const verifyIdx = source.indexOf("supabase.auth.verifyOtp({");
    const rpcIdx = source.indexOf('supabase.rpc("begin_self_recovery_password_change")');
    const pushIdx = source.indexOf('router.push("/dashboard")');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(verifyIdx);
    expect(pushIdx).toBeGreaterThan(rpcIdx);
  });

  it("kegagalan RPC TIDAK PERNAH lanjut ke redirect dashboard -- sesi recovery tidak diloloskan begitu saja", () => {
    const start = source.indexOf("async function handleVerifyOtp");
    const body = source.slice(start);
    const rpcErrIdx = body.indexOf("if (rpcError)");
    expect(rpcErrIdx).toBeGreaterThan(-1);
    const returnIdx = body.indexOf("return;", rpcErrIdx);
    const pushIdx = body.indexOf('router.push("/dashboard")', rpcErrIdx);
    expect(returnIdx).toBeGreaterThan(rpcErrIdx);
    expect(pushIdx).toBeGreaterThan(returnIdx);
  });

  it("tidak pernah menyentuh tabel users langsung dari client (delegasi penuh ke RPC)", () => {
    expect(source).not.toMatch(/from\(["']users["']\)/);
  });
});
