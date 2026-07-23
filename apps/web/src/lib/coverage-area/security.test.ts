import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");

describe("Coverage area creation security contracts (Owner Control Gate 1A)", () => {
  it("Server Action mengambil tenant/actor dari sesi dan memeriksa owner-only sebelum admin client", () => {
    expect(actions).toContain("getAuthUser()");
    expect(actions).toContain("user.company_id");
    expect(actions).toContain("isOwnerActor(user)");
    expect(actions).toContain("user.isDemo");

    const start = actions.indexOf("export async function createCoverageAreaAction");
    const body = actions.slice(start, start + 1200);
    expect(body.indexOf("getAuthUser()")).toBeLessThan(body.indexOf("getAdminClient()"));
    expect(body.indexOf("isOwnerActor(user)")).toBeLessThan(body.indexOf("getAdminClient()"));
  });

  it("gate hanya mengizinkan role 'owner', tidak manager/admin/super_admin", () => {
    const start = actions.indexOf("function isOwnerActor");
    const body = actions.slice(start, start + 200);
    expect(body).toContain('OWNER_ONLY_ROLES.some((role) => user.roles.includes(role))');
    const rolesLine = actions.match(/const OWNER_ONLY_ROLES = (\[[^\]]*\])/);
    expect(rolesLine).not.toBeNull();
    expect(JSON.parse(rolesLine![1])).toEqual(["owner"]);
  });

  it("companyId dan actorId yang dipakai repository selalu dari sesi (user.company_id/user.id), bukan dari parameter form", () => {
    const callStart = actions.indexOf("repo.createArea({");
    const callBody = actions.slice(callStart, callStart + 300);
    expect(callBody).toContain("companyId: user.company_id");
    expect(callBody).toContain("actorId: user.id");
  });

  it("fungsi export tidak menerima parameter companyId/actorId/role dari client", () => {
    const start = actions.indexOf("export async function createCoverageAreaAction(");
    const signatureEnd = actions.indexOf(")", start);
    const signature = actions.slice(start, signatureEnd);
    expect(signature).not.toMatch(/company_?id/i);
    expect(signature).not.toMatch(/actor_?id/i);
    expect(signature).not.toMatch(/\brole\b/i);
  });
});
