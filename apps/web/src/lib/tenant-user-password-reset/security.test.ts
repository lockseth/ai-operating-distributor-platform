import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
const types = readFileSync(path.resolve(__dirname, "types.ts"), "utf8");
const workflow = readFileSync(path.resolve(__dirname, "workflow.ts"), "utf8");
const repository = readFileSync(path.resolve(__dirname, "repository.ts"), "utf8");
const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260913000001_gate_3e_d2_a_r1_super_admin_tenant_user_password_reset.sql"
  ),
  "utf8"
);

describe("Super admin tenant-user password reset security contracts (Gate 3E-D2-A-R1)", () => {
  it("Server Action mengambil actor dari sesi dan memeriksa super_admin-only sebelum admin client", () => {
    expect(actions).toContain("getAuthUser()");
    expect(actions).toContain('user.roles.includes("super_admin")');

    const start = actions.indexOf("export async function resetTenantUserPasswordAction");
    const body = actions.slice(start, start + 1200);
    expect(body.indexOf("getAuthUser()")).toBeLessThan(body.indexOf("getAdminClient()"));
    expect(body.indexOf('user.roles.includes("super_admin")')).toBeLessThan(body.indexOf("getAdminClient()"));
  });

  it("Server Action hanya menerima targetUserId dari client -- tidak ada actorId/companyId/role/password", () => {
    const sigStart = actions.indexOf("export async function resetTenantUserPasswordAction(");
    const sigEnd = actions.indexOf(")", sigStart);
    // Hanya daftar PARAMETER (setelah tanda kurung buka) yang diperiksa --
    // bukan nama fungsinya sendiri, yang sah mengandung kata "Password".
    const paramList = actions.slice(sigStart + "export async function resetTenantUserPasswordAction(".length, sigEnd);
    expect(paramList).toContain("targetUserId: string");
    expect(paramList).not.toMatch(/actor_?id/i);
    expect(paramList).not.toMatch(/company_?id/i);
    expect(paramList).not.toMatch(/role/i);
    expect(paramList).not.toMatch(/password/i);
  });

  it("actorId yang dipakai workflow selalu dari sesi (user.id), tidak pernah dari parameter", () => {
    const callStart = actions.indexOf("resetTenantUserPassword(repo, {");
    const callBody = actions.slice(callStart, callStart + 200);
    expect(callBody).toContain("actorId: user.id");
    expect(callBody).not.toMatch(/actorId:\s*(input|targetUserId)/);
  });

  it("input workflow (ResetTenantUserPasswordInput) tidak punya field password/role/companyId", () => {
    const declStart = "export interface ResetTenantUserPasswordInput";
    const start = types.indexOf(declStart);
    const end = types.indexOf("}", start);
    // Hanya BODY interface (field-fieldnya) yang diperiksa -- bukan nama
    // interface itu sendiri, yang sah mengandung kata "Password".
    const shape = types.slice(start + declStart.length, end);
    expect(shape).toContain("actorId: string");
    expect(shape).toContain("targetUserId: string");
    expect(shape).not.toMatch(/password/i);
    expect(shape).not.toMatch(/role/i);
    expect(shape).not.toMatch(/company/i);
  });

  it("temporary password selalu dibuat server-side lewat generateSecureTempPassword() (CSPRNG), tidak pernah input", () => {
    expect(workflow).toContain('import { generateSecureTempPassword } from "../tenant-users/password"');
    expect(workflow).toContain("generateSecureTempPassword()");
    expect(workflow).not.toMatch(/input\.(temp)?[Pp]assword/);
  });

  it("tempPassword dikembalikan tepat satu kali pada outcome 'reset', tidak pernah di-log mentah", () => {
    expect(types).toMatch(/outcome:\s*"reset";\s*tempPassword:\s*string/);
    expect(workflow).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
    expect(actions).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
    expect(repository).not.toMatch(/console\.(log|error|warn)\([^)]*[Pp]assword/);
  });

  it("orkestrasi TS mengikuti urutan DB -> Auth -> DB (finalize), tidak pernah memanggil Auth sebelum begin() sukses", () => {
    const fnStart = workflow.indexOf("export async function resetTenantUserPassword");
    const beginIdx = workflow.indexOf("repo.beginReset(", fnStart);
    const authIdx = workflow.indexOf("repo.updateAuthPassword(", fnStart);
    const finalizeIdx = workflow.indexOf("repo.finalizeReset(", fnStart);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeGreaterThan(-1);
    expect(finalizeIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(authIdx);
    expect(authIdx).toBeLessThan(finalizeIdx);
    // Kegagalan begin() harus return sebelum baris updateAuthPassword tercapai.
    expect(workflow.slice(fnStart, authIdx)).toContain("if (!begin.ok)");
  });

  it("kegagalan Auth API memanggil failReset dengan reason string statis, tidak pernah authResult.message mentah", () => {
    const authFailIdx = workflow.indexOf("if (!authResult.ok)");
    const block = workflow.slice(authFailIdx, authFailIdx + 600);
    expect(block).toContain('reason: "auth_update_failed"');
    // authResult.message boleh disebut di KOMENTAR (dokumentasi kenapa TIDAK
    // dipakai) -- yang dilarang adalah memakainya sebagai NILAI reason.
    expect(block).not.toMatch(/reason:\s*authResult\.message/);
  });

  it("RPC begin() re-verifikasi actor (super_admin aktif) dan target (aktif, allowlist role, bukan super_admin) DI DALAM database", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.super_admin_begin_tenant_user_password_reset");
    const fnEnd = migration.indexOf("$$;", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).toContain("r.name = 'super_admin'");
    expect(fnBody).toContain("u.is_active = TRUE");
    expect(fnBody).toContain("v_target.is_active");
    expect(fnBody).toContain("'super_admin' = ANY(v_role_names)");
    expect(fnBody).toContain("ARRAY['owner', 'admin', 'sales']");
  });

  it("must_change_password diset TRUE fail-closed di dalam begin(), SEBELUM auth password sungguh diganti (TS)", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.super_admin_begin_tenant_user_password_reset");
    const fnEnd = migration.indexOf("$$;", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).toContain("must_change_password = TRUE, provisioned_password_hash = v_pre_hash");
  });

  it("finalize() menyegarkan baseline ke hash BARU dan menegaskan ulang must_change_password=TRUE (bukan membersihkannya)", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.super_admin_finalize_tenant_user_password_reset");
    const fnEnd = migration.indexOf("$$;", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).toContain("must_change_password = TRUE, provisioned_password_hash = v_new_hash");
    expect(fnBody).not.toMatch(/must_change_password\s*=\s*FALSE/);
  });

  it("fail() TIDAK PERNAH membersihkan must_change_password/provisioned_password_hash (fail-closed dipertahankan)", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.super_admin_fail_tenant_user_password_reset");
    const fnEnd = migration.indexOf("COMMENT ON FUNCTION public.super_admin_fail_tenant_user_password_reset", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/UPDATE public\.users/);
    expect(fnBody).not.toMatch(/must_change_password/);
  });

  it("audit event pada ketiga RPC tidak pernah menyertakan password/hash", () => {
    for (const fnName of [
      "super_admin_begin_tenant_user_password_reset",
      "super_admin_finalize_tenant_user_password_reset",
      "super_admin_fail_tenant_user_password_reset",
    ]) {
      const fnStart = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}`);
      const fnEnd = migration.indexOf("$$;", fnStart);
      const fnBody = migration.slice(fnStart, fnEnd);
      const auditStart = fnBody.indexOf("INSERT INTO public.audit_logs");
      if (auditStart === -1) continue;
      const auditInsert = fnBody.slice(auditStart, auditStart + 500);
      // Nama action seperti 'tenant_user.password_reset_started' SAH
      // mengandung kata "password" (taksonomi peristiwa, bukan rahasia) --
      // yang dilarang adalah variabel hash/password sungguhan ikut ter-insert.
      expect(auditInsert).not.toMatch(/v_pre_hash|v_new_hash|encrypted_password/);
    }
  });

  it("ketiga RPC hanya di-grant ke service_role -- tidak pernah anon/authenticated (anon/authenticated tidak bisa memanggil langsung)", () => {
    for (const fnSig of [
      "super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID)",
      "super_admin_finalize_tenant_user_password_reset(UUID, UUID, UUID)",
      "super_admin_fail_tenant_user_password_reset(UUID, UUID, UUID, TEXT)",
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fnSig}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fnSig}\n  TO service_role;`);
    }
  });

  it("tabel operasi reset di-REVOKE dari anon/authenticated (tidak diekspos lewat PostgREST)", () => {
    expect(migration).toContain("REVOKE ALL ON public.tenant_user_password_reset_operations FROM anon, authenticated;");
    expect(migration).toContain("ALTER TABLE public.tenant_user_password_reset_operations ENABLE ROW LEVEL SECURITY;");
  });

  it("hanya satu operasi in-flight per target (partial unique index) -- idempotency/duplicate-submission guard di level database", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX tenant_user_password_reset_operations_target_inflight");
    expect(migration).toContain("WHERE status IN ('started', 'db_committed')");
  });

  it("tidak ada kode KTP/selfie/face/liveness/biometric pada modul ini (non-biometric by design)", () => {
    const stripComments = (src: string) =>
      src
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").replace(/\/\/.*$/, ""))
        .join("\n");
    for (const file of [actions, types, workflow, repository, migration]) {
      expect(stripComments(file)).not.toMatch(/ktp|selfie|face.?match|face.?embedding|liveness|biometric/i);
    }
  });
});
