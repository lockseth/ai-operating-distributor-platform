import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
const types = readFileSync(path.resolve(__dirname, "types.ts"), "utf8");
const workflow = readFileSync(path.resolve(__dirname, "workflow.ts"), "utf8");
const service = readFileSync(path.resolve(__dirname, "service.ts"), "utf8");
const password = readFileSync(path.resolve(__dirname, "password.ts"), "utf8");
const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260911000001_gate_3e_c_c2_b1_owner_created_user_mandatory_password.sql"
  ),
  "utf8"
);

describe("Owner-created tenant user security contracts (Gate 3E-C-C2-B1)", () => {
  it("Server Action mengambil tenant dari sesi dan memeriksa owner-only sebelum admin client", () => {
    expect(actions).toContain("getAuthUser()");
    expect(actions).toContain("user.company_id");
    expect(actions).toContain("user.isDemo");

    const start = actions.indexOf("export async function createTenantUserAction");
    const body = actions.slice(start, start + 1200);
    expect(body.indexOf("getAuthUser()")).toBeLessThan(body.indexOf("getAdminClient()"));
    expect(body.indexOf("isOwnerActor(user)")).toBeLessThan(body.indexOf("getAdminClient()"));

    const fnStart = actions.indexOf("function isOwnerActor");
    const fnBody = actions.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain('user.roles.includes("owner")');
    expect(fnBody).not.toMatch(/manager|admin|super_admin/i);
  });

  it("form input dari client TIDAK memiliki field company_id, actorId, atau tempPassword", () => {
    expect(actions).toContain("export interface CreateTenantUserFormInput");
    const start = actions.indexOf("export interface CreateTenantUserFormInput");
    const end = actions.indexOf("}", start);
    const formInputShape = actions.slice(start, end);
    expect(formInputShape).not.toMatch(/company_?id/i);
    expect(formInputShape).not.toMatch(/actor_?id/i);
    expect(formInputShape).not.toMatch(/temp_?password/i);
    expect(formInputShape).not.toMatch(/permission/i);
  });

  it("company_id/actorId yang dipakai workflow selalu dari sesi (user.company_id/user.id), bukan dari form input", () => {
    const callStart = actions.indexOf("createTenantUser(repo, {");
    const callBody = actions.slice(callStart, callStart + 400);
    expect(callBody).toContain("companyId: user.company_id");
    expect(callBody).toContain("actorId: user.id");
    expect(callBody).not.toContain("companyId: input.");
    expect(callBody).not.toContain("actorId: input.");
  });

  it("role hanya boleh diambil dari allowlist {admin, sales} -- ditolak ulang di workflow (bukan hanya actions.ts)", () => {
    expect(actions).toContain("isTenantAssignableRole(input.role)");
    expect(service).toContain('"admin", "sales"');
    expect(workflow).toContain("validateCreateTenantUserInput");
  });

  it("temporary password TIDAK PERNAH berasal dari input client -- selalu dibuat server-side", () => {
    const inputStart = types.indexOf("export interface CreateTenantUserInput");
    const inputEnd = types.indexOf("}", inputStart);
    const inputShape = types.slice(inputStart, inputEnd);
    expect(inputShape).not.toMatch(/tempPassword/);

    expect(actions).not.toMatch(/input\.tempPassword/);
    expect(workflow).toContain("generateSecureTempPassword()");
    expect(password).toContain("randomBytes");
  });

  it("workflow mengembalikan tempPassword tepat satu kali pada outcome 'created', tidak pernah di-log", () => {
    expect(types).toMatch(/outcome:\s*"created";\s*userId:\s*string;\s*tempPassword:\s*string/);
    expect(workflow).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
    expect(actions).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
  });

  it("role_id yang di-assign selalu dari findRoleIdByName() (lookup DB), tidak pernah literal/parameter bebas", () => {
    expect(workflow).toContain("repo.findRoleIdByName(input.role)");
    expect(workflow).not.toMatch(/roleId\s*:\s*input\.(?!role\b)/);
  });

  it("RPC provisioning re-verifikasi actor (owner aktif, tenant sama) dan role allowlist DI DALAM database, bukan hanya mempercayai parameter", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.provision_owner_created_tenant_user");
    const fnBody = migration.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain("r.name = 'owner'");
    expect(fnBody).toContain("u.is_active = TRUE");
    expect(fnBody).toContain("public.is_tenant_assignable_role(p_role_id, p_company_id)");
  });

  it("audit event provisioning (di dalam RPC) tidak pernah menyertakan password/hash", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.provision_owner_created_tenant_user");
    const fnEnd = migration.indexOf("$$;", fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    const auditStart = fnBody.indexOf("INSERT INTO public.audit_logs");
    const auditInsert = fnBody.slice(auditStart, auditStart + 400);
    expect(auditInsert).not.toMatch(/password/i);
    expect(auditInsert).not.toMatch(/v_password_hash/);
  });

  it("must_change_password selalu TRUE dan password hash snapshot dibaca dari auth.users, bukan parameter", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.provision_owner_created_tenant_user");
    const fnBody = migration.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain("SELECT encrypted_password INTO v_password_hash");
    expect(fnBody).toContain("FROM auth.users WHERE id = p_user_id");
    expect(fnBody).toMatch(/TRUE,\s*\n\s*TRUE, v_password_hash/);
  });

  it("complete_mandatory_password_change() identitasnya selalu auth.uid(), tidak pernah menerima parameter user_id", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.complete_mandatory_password_change()");
    const sigLine = migration.slice(fnStart, migration.indexOf("RETURNS", fnStart));
    expect(sigLine).toContain("()");
    const fnBody = migration.slice(fnStart, fnStart + 2000);
    expect(fnBody).toContain("v_caller_id := auth.uid()");
    expect(fnBody).not.toMatch(/p_user_id/);
  });

  it("provision_owner_created_tenant_user hanya di-grant ke service_role; complete_mandatory_password_change hanya ke authenticated", () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.provision_owner_created_tenant_user\([^)]*\)\s*\n\s*TO service_role;/
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.complete_mandatory_password_change\(\)\s*\n\s*TO authenticated;/
    );
  });

  it("tidak ada kode KTP/selfie/face/liveness/biometric pada modul tenant-users (non-biometric by design)", () => {
    const stripComments = (src: string) =>
      src
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
    for (const file of [actions, types, workflow, service, password]) {
      expect(stripComments(file)).not.toMatch(/ktp|selfie|face.?match|face.?embedding|liveness|biometric/i);
    }
  });
});
