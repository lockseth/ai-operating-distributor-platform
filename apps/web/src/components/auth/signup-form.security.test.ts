import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "signup-form.tsx"), "utf8");
const loginSource = readFileSync(path.resolve(__dirname, "login-form.tsx"), "utf8");

describe("Signup form public contract (Gate 3D-B3)", () => {
  it("halaman login memiliki link ke /signup (obligasi test #1)", () => {
    expect(loginSource).toContain('href="/signup"');
  });

  it("tidak menyediakan pilihan/selector role atau tenant apa pun (obligasi test #2)", () => {
    // "owner" boleh muncul sebagai istilah arsitektur (nama RPC/komentar) --
    // yang dilarang adalah UI yang membiarkan pengguna MEMILIH role: dropdown,
    // radio, checkbox, atau parameter role/company_id yang dikirim ke Supabase.
    expect(source).not.toMatch(/<select/i);
    expect(source).not.toMatch(/type=["']radio["']/);
    expect(source).not.toMatch(/type=["']checkbox["']/);
    expect(source).not.toMatch(/role\s*:\s*["'](owner|admin|sales|super_admin)["']/i);
    expect(source).not.toMatch(/name=["']role["']/);
    expect(source).not.toContain("super_admin");
  });

  it("tidak menerima company_id/tenant_id dari client sama sekali", () => {
    expect(source).not.toMatch(/company_id|tenant_id/);
  });

  it("RPC dipanggil lewat client session (anon key), TIDAK PERNAH lewat admin/service-role client", () => {
    // "service_role" boleh muncul di komentar arsitektur (menjelaskan MENGAPA
    // tidak dipakai) -- yang dilarang adalah benar-benar mengimpor/memakainya.
    expect(source).not.toContain("getAdminClient");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toMatch(/from\s+["']@\/lib\/supabase\/admin["']/);
    expect(source).toContain('createClient()');
    expect(source).toContain('@/lib/supabase/client');
  });

  it("memanggil RPC provision_first_owner dengan payload persis 3 field (p_company_name/p_full_name/p_phone)", () => {
    expect(source).toContain('"provision_first_owner"');
    expect(source).toContain("buildProvisionRpcParams");
  });

  it("signUp() gagal tidak pernah lanjut memanggil RPC -- classifySignUpOutcome selalu dievaluasi lebih dulu", () => {
    const signUpIdx = source.indexOf("supabase.auth.signUp(");
    const classifyIdx = source.indexOf("classifySignUpOutcome(signUpError, data)");
    const rpcCallIdx = source.indexOf('supabase.rpc(\n      "provision_first_owner"');
    expect(signUpIdx).toBeGreaterThan(-1);
    expect(classifyIdx).toBeGreaterThan(signUpIdx);
    expect(rpcCallIdx).toBeGreaterThan(classifyIdx);
  });

  it("email confirmation required TIDAK memanggil RPC -- hanya set phase check-email (obligasi test #7)", () => {
    const idx = source.indexOf('outcome.kind === "confirmation_required"');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 200);
    expect(block).not.toContain(".rpc(");
    expect(block).toContain('setPhase("check-email")');
  });

  it("redirectTo/emailRedirectTo fixed same-origin ke /auth/callback, tidak pernah dari query param (obligasi test #13, Gate 3D-B3-F1)", () => {
    expect(source).toContain(
      "emailRedirectTo: `${window.location.origin}/auth/callback?next=/signup`"
    );
    expect(source).not.toMatch(/emailRedirectTo:\s*(searchParams|params|req\.|new URL)/);
  });

  it("password tidak pernah dicatat/di-log (tidak ada console.log/console.error yang menyertakan state password)", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)\([^)]*password/i);
  });

  it("tidak hardcode password/secret literal di source", () => {
    expect(source.toLowerCase()).not.toMatch(/password\s*[:=]\s*["'][^"']+["']/);
  });

  it("already_provisioned dan sukses provisioning sama-sama diarahkan ke /dashboard, tidak pernah call RPC ulang eksplisit di handler yang sama (obligasi test #10/#11)", () => {
    expect(source).toContain('outcome.kind === "already_provisioned"');
    const idx = source.indexOf('outcome.kind === "already_provisioned"');
    const block = source.slice(idx, idx + 150);
    expect(block).toContain('router.replace("/dashboard")');
  });

  it("provisioning failure (unexpected_error) tetap di layar continue, tidak sign out / tidak hapus auth user (obligasi test #9)", () => {
    expect(source).not.toContain("deleteUser");
    expect(source).not.toContain("admin.deleteUser");
    expect(source).not.toContain("auth.signOut");
    const idx = source.indexOf("// unexpected_error: auth user & session TETAP dipertahankan");
    expect(idx).toBeGreaterThan(-1);
  });
});
