// Gate 3D-B3-F1 — source-contract tests untuk /auth/callback, mirror pola
// signup-form.security.test.ts (baca source, assert invariant keamanan yang
// tidak mudah lolos dari perubahan tak sengaja di masa depan).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "route.ts"), "utf8");

describe("/auth/callback security contract (Gate 3D-B3-F1)", () => {
  it("menukar code lewat exchangeCodeForSession, bukan sekadar getSession", () => {
    expect(source).toContain("exchangeCodeForSession(code)");
    expect(source).not.toContain(".auth.getSession()");
  });

  it("tujuan redirect sukses dibangun dari resolveCallbackNextPath (allowlist), bukan next mentah", () => {
    expect(source).toContain('resolveCallbackNextPath(searchParams.get("next"))');
    expect(source).not.toMatch(/redirect\(`\$\{origin\}\$\{searchParams\.get\("next"\)/);
  });

  it("redirect selalu dibangun dari origin request sendiri (same-origin), tidak pernah host eksternal", () => {
    const redirectCalls = source.match(/NextResponse\.redirect\(([^)]*)\)/g) ?? [];
    expect(redirectCalls.length).toBeGreaterThan(0);
    for (const call of redirectCalls) {
      expect(call).toMatch(/\$\{origin\}/);
    }
  });

  it("fail-closed saat code hilang -- tidak lanjut ke exchange", () => {
    const idx = source.indexOf("if (!code)");
    expect(idx).toBeGreaterThan(-1);
    const exchangeIdx = source.indexOf("exchangeCodeForSession");
    expect(exchangeIdx).toBeGreaterThan(idx);
  });

  it("kegagalan exchange (error maupun exception) dibungkus try/catch, tidak pernah bocor ke redirect", () => {
    expect(source).toContain("try {");
    expect(source).toContain("catch");
    expect(source).not.toMatch(/redirect\(`[^`]*\$\{error/);
  });

  it("tidak pernah memanggil provisioning/RPC apa pun di sini (bukan tanggung jawab route ini)", () => {
    expect(source).not.toContain(".rpc(");
    expect(source).not.toContain("provision_first_owner");
    expect(source).not.toMatch(/company_id|tenant_id/);
  });

  it("tidak memakai service-role/admin client", () => {
    expect(source).not.toContain("getAdminClient");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase\/admin["']/);
  });

  it("code dan pesan error tidak pernah di-log", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});
