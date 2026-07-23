import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
const types = readFileSync(path.resolve(__dirname, "types.ts"), "utf8");
const workflow = readFileSync(path.resolve(__dirname, "workflow.ts"), "utf8");

describe("Salesman creation security contracts", () => {
  it("Server Action mengambil tenant dari sesi dan memeriksa izin sebelum admin client", () => {
    expect(actions).toContain("getAuthUser()");
    expect(actions).toContain("user.company_id");
    expect(actions).toContain('"users.manage"');
    expect(actions).toContain("user.isDemo");

    const start = actions.indexOf("export async function createSalesmanAction");
    const body = actions.slice(start, start + 1200);
    expect(body.indexOf("getAuthUser()")).toBeLessThan(body.indexOf("getAdminClient()"));
    expect(body.indexOf("canManageSalesman(user)")).toBeLessThan(body.indexOf("getAdminClient()"));
  });

  it("form input dari client TIDAK memiliki field company_id, role, atau privilege", () => {
    expect(actions).toContain("export interface CreateSalesmanFormInput");
    const start = actions.indexOf("export interface CreateSalesmanFormInput");
    const end = actions.indexOf("}", start);
    const formInputShape = actions.slice(start, end);
    expect(formInputShape).not.toMatch(/company_?id/i);
    expect(formInputShape).not.toMatch(/\brole\b/i);
    expect(formInputShape).not.toMatch(/permission/i);
  });

  it("company_id yang dipakai workflow selalu dari user.company_id (sesi), bukan dari form input", () => {
    const callStart = actions.indexOf("createSalesman(repo, {");
    const callBody = actions.slice(callStart, callStart + 400);
    expect(callBody).toContain("companyId: user.company_id");
    expect(callBody).not.toContain("companyId: input.");
    expect(callBody).toContain("actorId: user.id");
  });

  it("role Salesman selalu berasal dari findSalesRoleId(), tidak pernah parameter role bebas", () => {
    expect(types).not.toMatch(/role\s*:\s*string/i);
    expect(workflow).toContain("repo.findSalesRoleId()");
    expect(workflow).not.toMatch(/roleId\s*:\s*input\./);
  });

  it("audit event tidak pernah menyertakan password/tempPassword", () => {
    const start = actions.indexOf("logAuditEvent({");
    const end = actions.indexOf("});", start);
    const auditCall = actions.slice(start, end);
    expect(auditCall).not.toMatch(/password/i);
    expect(auditCall).not.toMatch(/tempPassword/i);
  });

  it("createSalesmanAction diproteksi Owner Control Gate 1A: hanya Owner tenant (bukan manager/admin/super_admin) yang dapat menambahkan Salesman", () => {
    const start = actions.indexOf("export async function createSalesmanAction");
    const body = actions.slice(start, start + 1200);
    expect(body).toContain("isOwnerActor(user)");
    expect(body.indexOf("isOwnerActor(user)")).toBeLessThan(body.indexOf("getAdminClient()"));

    const fnStart = actions.indexOf("function isOwnerActor");
    const fnBody = actions.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain('user.roles.includes("owner")');
    expect(fnBody).not.toMatch(/manager|admin|super_admin/i);
  });

  it("updateSalesmanCoverageAreasAction (Ubah Wilayah Salesman existing) diproteksi owner-only juga -- satu domain Owner Control Plane dengan createSalesmanAction", () => {
    const start = actions.indexOf("export async function updateSalesmanCoverageAreasAction");
    const body = actions.slice(start, start + 800);
    expect(body).toContain("getAuthUser()");
    expect(body).toContain("isOwnerActor(user)");
    expect(body.indexOf("getAuthUser()")).toBeLessThan(body.indexOf("getAdminClient()"));
    expect(body.indexOf("isOwnerActor(user)")).toBeLessThan(body.indexOf("getAdminClient()"));
  });

  it("tidak ada kode KTP/selfie/face/liveness/biometric pada modul Salesman (non-biometric by design)", () => {
    // Strip komentar '//' -- dokumentasi yang MENJELASKAN ketiadaan biometrik
    // boleh menyebut kata tsb; yang dilarang adalah kode (identifier/field)
    // yang benar-benar memakainya.
    const stripComments = (src: string) =>
      src
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
    for (const file of [actions, types, workflow]) {
      expect(stripComments(file)).not.toMatch(/ktp|selfie|face.?match|face.?embedding|liveness|biometric/i);
    }
  });
});
