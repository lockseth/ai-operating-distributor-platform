// Gate 3E-C-C2-B4-R1 — source-contract tests untuk /auth/confirm, mirror pola
// app/auth/callback/route.security.test.ts (baca source, assert invariant
// keamanan yang tidak mudah lolos dari perubahan tak sengaja di masa depan).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "route.ts"), "utf8");

describe("/auth/confirm security contract (Gate 3E-C-C2-B4-R1)", () => {
  it("menukar token_hash lewat verifyOtp({ type: recovery }), bukan exchangeCodeForSession/getSession", () => {
    expect(source).toContain("token_hash: tokenHash");
    expect(source).toContain('type: "recovery"');
    expect(source).not.toContain(".exchangeCodeForSession(");
    expect(source).not.toContain(".auth.getSession()");
  });

  it("type wajib persis 'recovery' -- type lain ditolak sebelum verifyOtp dipanggil", () => {
    const idx = source.indexOf('type !== "recovery"');
    expect(idx).toBeGreaterThan(-1);
    const verifyIdx = source.indexOf(".auth.verifyOtp(");
    expect(verifyIdx).toBeGreaterThan(idx);
  });

  it("tujuan redirect sukses dibangun dari resolveConfirmNextPath (allowlist), bukan next mentah", () => {
    expect(source).toContain('resolveConfirmNextPath(searchParams.get("next"))');
    expect(source).not.toMatch(/redirect\(`\$\{origin\}\$\{searchParams\.get\("next"\)/);
  });

  it("redirect selalu dibangun dari origin request sendiri (same-origin), tidak pernah host eksternal", () => {
    const redirectCalls = source.match(/NextResponse\.redirect\(([^)]*)\)/g) ?? [];
    expect(redirectCalls.length).toBeGreaterThan(0);
    for (const call of redirectCalls) {
      expect(call).toMatch(/\$\{origin\}/);
    }
  });

  it("fail-closed saat token_hash hilang -- tidak lanjut ke verifyOtp", () => {
    const idx = source.indexOf("if (!tokenHash");
    expect(idx).toBeGreaterThan(-1);
    const verifyIdx = source.indexOf(".auth.verifyOtp(");
    expect(verifyIdx).toBeGreaterThan(idx);
  });

  it("kegagalan verifyOtp (error maupun exception) dibungkus try/catch, tidak pernah bocor ke redirect", () => {
    expect(source).toContain("try {");
    expect(source).toContain("catch");
    expect(source).not.toMatch(/redirect\(`[^`]*\$\{error/);
  });

  it("token_hash TIDAK PERNAH diteruskan ke redirect/response (hanya dipakai sebagai argumen verifyOtp)", () => {
    expect(source).not.toMatch(/redirect\(`[^`]*\$\{tokenHash/);
    expect(source).not.toMatch(/redirect\(`[^`]*token_hash/);
  });

  it("tidak pernah memanggil provisioning/RPC apa pun di sini (bukan tanggung jawab route ini)", () => {
    expect(source).not.toContain(".rpc(");
    expect(source).not.toContain("must_change_password");
    expect(source).not.toMatch(/company_id|tenant_id/);
  });

  it("tidak memakai service-role/admin client", () => {
    expect(source).not.toContain("getAdminClient");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase\/admin["']/);
  });

  it("token_hash dan pesan error tidak pernah di-log", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});
