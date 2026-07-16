import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260722000001_telegram_salesman_identity_enrollment.sql",
  ),
  "utf8",
);
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
const salesWorkflow = readFileSync(
  path.resolve(__dirname, "../sales-orders/workflow.ts"),
  "utf8",
);
const salesRepository = readFileSync(
  path.resolve(__dirname, "../sales-orders/repository.ts"),
  "utf8",
);

describe("Telegram enrollment security contracts", () => {
  it("database menyimpan token_hash, tidak memiliki kolom raw token", () => {
    expect(migration).toContain("token_hash");
    expect(migration).toContain("^[0-9a-f]{64}$");
    expect(migration).not.toMatch(/\braw_token\b/);
    expect(migration).not.toMatch(/\btoken_plaintext\b/);
  });

  it("issue/claim/revoke atomik hanya executable oleh service_role", () => {
    for (const routine of [
      "issue_telegram_salesman_enrollment",
      "claim_telegram_salesman_identity",
      "revoke_telegram_salesman_identity",
    ]) {
      expect(migration).toContain(`FUNCTION public.${routine}`);
    }
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBe(3);
    expect(
      migration.match(/SET search_path = pg_catalog, public/g)?.length,
    ).toBe(3);
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration.match(/TO service_role/g)?.length).toBe(3);
  });

  it("Server Action mengambil tenant dari sesi dan memeriksa izin sebelum admin client", () => {
    expect(actions).toContain("getAuthUser()");
    expect(actions).toContain("user.company_id");
    expect(actions).toContain('"telegram.manage"');
    expect(actions).toContain("user.isDemo");

    const issueStart = actions.indexOf(
      "export async function createTelegramEnrollmentAction",
    );
    const issueSignature = (actions.match(
      /export async function createTelegramEnrollmentAction\([^)]*\)/,
    ) ?? [])[0];
    const issueBody = actions.slice(issueStart, issueStart + 1700);
    expect(issueBody.indexOf("getAuthUser()")).toBeLessThan(
      issueBody.indexOf("getAdminClient()"),
    );
    expect(issueSignature).toBeDefined();
    expect(issueSignature).not.toMatch(/company_?id\s*:/i);
    expect(issueBody).toContain("p_company_id: user.company_id");
  });

  it("enrollment update tidak pernah menyimpan command/token ke event ledger", () => {
    const enrollmentStart = salesWorkflow.indexOf(
      "const enrollment = await processTelegramEnrollment",
    );
    const enrollmentBranch = salesWorkflow.slice(
      enrollmentStart,
      enrollmentStart + 1800,
    );
    expect(enrollmentBranch).toContain("rawPayload: null");
    expect(enrollmentBranch).not.toContain("rawPayload: update");
  });

  it("satu Salesman hanya boleh memiliki satu identity Telegram aktif", () => {
    expect(migration).toContain("uq_telegram_identity_active_user");
    expect(migration).toContain("WHERE is_active = TRUE");
    expect(migration).toContain("HAVING COUNT(*) > 1");
  });

  it("identity aktif tetap fail closed bila user nonaktif atau tenant tidak cocok", () => {
    expect(salesRepository).toContain("row.user.is_active !== true");
    expect(salesRepository).toContain("row.user.company_id !== row.company_id");
  });
});
