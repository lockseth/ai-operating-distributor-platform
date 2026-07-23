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
const ownerOnlyMigration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260818000001_telegram_pairing_owner_only.sql",
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

  it("Gate 1C: createTelegramEnrollmentAction dan disconnectTelegramIdentityAction owner-only, bukan manager/admin/super_admin", () => {
    expect(actions).toContain("function isOwnerActor");
    const fnStart = actions.indexOf("function isOwnerActor");
    const fnBody = actions.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain('user.roles.includes("owner")');
    expect(fnBody).not.toMatch(/manager|admin|super_admin/i);

    const issueStart = actions.indexOf(
      "export async function createTelegramEnrollmentAction",
    );
    const issueBody = actions.slice(issueStart, issueStart + 1700);
    expect(issueBody).toContain("isOwnerActor(user)");
    expect(issueBody.indexOf("isOwnerActor(user)")).toBeLessThan(
      issueBody.indexOf("getAdminClient()"),
    );

    const revokeStart = actions.indexOf(
      "export async function disconnectTelegramIdentityAction",
    );
    const revokeBody = actions.slice(revokeStart, revokeStart + 1200);
    expect(revokeBody).toContain("getAuthUser()");
    expect(revokeBody).toContain("isOwnerActor(user)");
    expect(revokeBody).toContain("user.isDemo");
    expect(revokeBody.indexOf("getAuthUser()")).toBeLessThan(
      revokeBody.indexOf("getAdminClient()"),
    );
    expect(revokeBody.indexOf("isOwnerActor(user)")).toBeLessThan(
      revokeBody.indexOf("getAdminClient()"),
    );

    const revokeCallStart = actions.indexOf(
      'revoke_telegram_salesman_identity",',
      revokeStart,
    );
    const revokeCallBody = actions.slice(revokeCallStart, revokeCallStart + 300);
    expect(revokeCallBody).toContain("p_company_id: user.company_id");
    expect(revokeCallBody).toContain("p_revoked_by: user.id");
    expect(revokeCallBody).not.toContain("p_company_id: input.");
    expect(revokeCallBody).not.toContain("p_revoked_by: input.");
  });

  it("Gate 1C: RPC issue/revoke actor gate direstriksi ke role 'owner' saja (CREATE OR REPLACE, bukan RPC baru)", () => {
    expect(ownerOnlyMigration).toContain(
      "FUNCTION public.issue_telegram_salesman_enrollment",
    );
    expect(ownerOnlyMigration).toContain(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    expect(ownerOnlyMigration).toContain(
      "FUNCTION public.claim_telegram_salesman_identity",
    );
    expect(ownerOnlyMigration.match(/AND r\.name = 'owner'/g)?.length).toBe(2);
    expect(ownerOnlyMigration).not.toMatch(
      /r\.name IN \('owner','manager','admin','super_admin'\)/,
    );
    // issue + revoke + claim -- ketiganya CREATE OR REPLACE di migration yang
    // sama (claim ditambahkan pada corrective pass klaim-time eligibility,
    // TIDAK mengubah gate actor issue/revoke).
    expect(ownerOnlyMigration.match(/SECURITY DEFINER/g)?.length).toBe(3);
    expect(ownerOnlyMigration).toContain("FROM PUBLIC, anon, authenticated");
    expect(ownerOnlyMigration.match(/TO service_role/g)?.length).toBe(3);
  });

  it("Gate 1C: reset tetap mencabut identity, conversation state, dan token pending yang belum diklaim dalam satu fungsi", () => {
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);
    expect(revokeFnBody).toContain("telegram_conversation_state");
    expect(revokeFnBody).toContain("delivery_conversation_state");
    expect(revokeFnBody).toContain("is_active = FALSE");
    expect(revokeFnBody).toContain("claimed_at IS NULL");
    expect(revokeFnBody).toContain("'not_found'::TEXT");
    expect(revokeFnBody).toContain("'telegram.identity_disconnected'");
  });

  it("Gate 1C: reset terhadap Salesman nonaktif tetap diizinkan (tidak mensyaratkan target is_active)", () => {
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);
    expect(revokeFnBody).not.toMatch(/target.*is_active\s*=\s*TRUE/i);
  });

  // ---------------------------------------------------------------------
  // Corrective verification pass -- target-sales enforcement on revoke,
  // and the full authorization/lifecycle test matrix requested for Gate 1C.
  // ---------------------------------------------------------------------

  it("Gate 1C corrective: revoke memvalidasi target role 'sales' independen SEBELUM lookup identity (bukan mengandalkan gate saat issue)", () => {
    const issueFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.issue_telegram_salesman_enrollment",
    );
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);

    // 'sales' role check muncul di issue (existing), revoke (corrective),
    // dan claim (v_has_sales_role, existing re-check yang dipertahankan).
    expect(ownerOnlyMigration.match(/r\.name = 'sales'/g)?.length).toBe(3);
    expect(revokeFnBody).toContain("v_target_is_sales");
    expect(revokeFnBody).toContain("r.name = 'sales'");

    const targetCheckIdx = revokeFnBody.indexOf("v_target_is_sales BOOLEAN");
    const targetQueryIdx = revokeFnBody.indexOf("INTO v_target_is_sales");
    const targetRejectIdx = revokeFnBody.indexOf("IF NOT v_target_is_sales");
    const identityLookupIdx = revokeFnBody.indexOf("INTO v_identity");
    expect(targetCheckIdx).toBeGreaterThan(-1);
    expect(targetQueryIdx).toBeLessThan(targetRejectIdx);
    expect(targetRejectIdx).toBeLessThan(identityLookupIdx);

    // Target non-sales mendapat outcome sama dgn "tidak ada identity aktif"
    // (not_found) -- tidak ada outcome pembeda yang membocorkan keberadaan
    // user/identity ke actor.
    const rejectBranch = revokeFnBody.slice(
      targetRejectIdx,
      revokeFnBody.indexOf("END IF;", targetRejectIdx) + "END IF;".length,
    );
    expect(rejectBranch).toContain("'not_found'::TEXT");

    expect(issueFnStart).toBeLessThan(revokeFnStart);
  });

  it("Gate 1C corrective: target-sales check pada revoke tidak mensyaratkan users.is_active (Salesman nonaktif tetap bisa direset)", () => {
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);
    const queryEnd = revokeFnBody.indexOf("INTO v_target_is_sales");
    const queryStart = revokeFnBody.lastIndexOf("SELECT EXISTS (", queryEnd);
    const targetQuery = revokeFnBody.slice(queryStart, queryEnd);
    expect(targetQuery).toContain("r.name = 'sales'");
    expect(targetQuery).not.toContain("public.users");
    expect(targetQuery).not.toContain("is_active");
  });

  it("Gate 1C: issue tetap mensyaratkan target Salesman AKTIF (syarat issue tidak berubah oleh corrective pass)", () => {
    const issueFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.issue_telegram_salesman_enrollment",
    );
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const issueFnBody = ownerOnlyMigration.slice(issueFnStart, revokeFnStart);
    expect(issueFnBody).toContain("v_target_allowed");
    const targetQueryStart = issueFnBody.indexOf("INTO v_target_allowed");
    const targetQueryBlock = issueFnBody.slice(
      issueFnBody.lastIndexOf("SELECT EXISTS (", targetQueryStart),
      targetQueryStart,
    );
    expect(targetQueryBlock).toContain("u.is_active = TRUE");
    expect(targetQueryBlock).toContain("r.name = 'sales'");
    expect(issueFnBody).toContain("'not_eligible'::TEXT");
  });

  it("Gate 1C: actor nonaktif ditolak independen di RPC pada issue maupun revoke (u.is_active = TRUE pada actor check)", () => {
    const issueFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.issue_telegram_salesman_enrollment",
    );
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const issueActorBlock = ownerOnlyMigration.slice(
      issueFnStart,
      ownerOnlyMigration.indexOf("INTO v_actor_allowed", issueFnStart),
    );
    const revokeActorBlock = ownerOnlyMigration.slice(
      revokeFnStart,
      ownerOnlyMigration.indexOf("INTO v_actor_allowed", revokeFnStart),
    );
    expect(issueActorBlock).toContain("u.is_active = TRUE");
    expect(issueActorBlock).toContain("r.name = 'owner'");
    expect(revokeActorBlock).toContain("u.is_active = TRUE");
    expect(revokeActorBlock).toContain("r.name = 'owner'");
  });

  it("Gate 1C: actor dan target selalu dibandingkan terhadap p_company_id yang sama (cross-tenant actor/target ditolak) pada issue dan revoke", () => {
    const issueFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.issue_telegram_salesman_enrollment",
    );
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const issueFnBody = ownerOnlyMigration.slice(issueFnStart, revokeFnStart);
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);

    // issue: actor + target keduanya dibatasi ke p_company_id
    expect(issueFnBody.match(/u\.company_id = p_company_id/g)?.length).toBe(2);
    // revoke: actor (users) + target-sales (user_roles) + identity lookup,
    // semua dibatasi ke p_company_id yang sama.
    expect(revokeFnBody).toContain("u.company_id = p_company_id");
    expect(revokeFnBody).toContain("ur.company_id = p_company_id");
    expect(revokeFnBody).toContain("company_id = p_company_id");
  });

  it("Gate 1C: token yang sudah di-revoke tidak dapat diklaim ulang (claim fail-closed pada revoked_at)", () => {
    expect(migration).toContain("v_token.revoked_at IS NOT NULL");
    const claimStart = migration.indexOf(
      "FUNCTION public.claim_telegram_salesman_identity",
    );
    const claimBody = migration.slice(claimStart, claimStart + 1200);
    expect(claimBody).toContain("v_token.revoked_at IS NOT NULL");
    expect(claimBody).toContain("'invalid_or_expired'::TEXT");
  });

  it("Gate 1C: resolver Telegram menolak identity yang tidak aktif (filter is_active pada telegram_identities, bukan hanya user.is_active)", () => {
    const resolveStart = salesRepository.indexOf("async resolveIdentity(");
    const resolveBody = salesRepository.slice(resolveStart, resolveStart + 800);
    expect(resolveBody).toContain('.eq("is_active", true)');
    expect(resolveBody).toContain("row.user.is_active !== true");
  });

  it("Gate 1C: repeated revoke (tidak ada identity aktif) return SEBELUM audit insert manapun -- no-op tanpa audit duplikat", () => {
    const revokeFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.revoke_telegram_salesman_identity",
    );
    const revokeFnBody = ownerOnlyMigration.slice(revokeFnStart);
    const identityNotFoundIdx = revokeFnBody.indexOf("IF NOT FOUND THEN");
    const auditInsertIdx = revokeFnBody.indexOf("INSERT INTO public.audit_logs");
    expect(identityNotFoundIdx).toBeGreaterThan(-1);
    expect(auditInsertIdx).toBeGreaterThan(-1);
    expect(identityNotFoundIdx).toBeLessThan(auditInsertIdx);
  });

  it("Gate 1C: issue dan revoke sukses tetap menghasilkan audit event bertipe berbeda", () => {
    expect(ownerOnlyMigration).toContain("'telegram.enrollment_issued'");
    expect(ownerOnlyMigration).toContain("'telegram.identity_disconnected'");
  });

  // ---------------------------------------------------------------------
  // Final corrective -- claim-time eligibility re-check on
  // claim_telegram_salesman_identity (CREATE OR REPLACE dalam migration
  // Gate 1C yang sama, 20260818000001).
  // ---------------------------------------------------------------------

  describe("Gate 1C final corrective: claim-time eligibility", () => {
    const claimFnStart = ownerOnlyMigration.indexOf(
      "FUNCTION public.claim_telegram_salesman_identity",
    );
    const claimFnBody = ownerOnlyMigration.slice(claimFnStart);
    const eligibilityIfStart = claimFnBody.indexOf(
      "IF NOT v_user_found OR NOT v_has_sales_role THEN",
    );
    const eligibilityIfEnd =
      claimFnBody.indexOf("END IF;", eligibilityIfStart) + "END IF;".length;
    const eligibilityBranch = claimFnBody.slice(
      eligibilityIfStart,
      eligibilityIfEnd,
    );

    it("claim function baru ada di migration Gate 1C yang sama (CREATE OR REPLACE, bukan migration baru)", () => {
      expect(claimFnStart).toBeGreaterThan(-1);
      expect(
        ownerOnlyMigration.indexOf(
          "CREATE OR REPLACE FUNCTION public.claim_telegram_salesman_identity",
        ),
      ).toBe(claimFnStart - "CREATE OR REPLACE ".length);
    });

    it("target masih Salesman aktif dalam tenant token -> re-check lolos (v_user_found DAN v_has_sales_role dievaluasi ulang dari state saat ini, discope ke v_token.company_id)", () => {
      const userQueryStart = claimFnBody.indexOf("INTO v_user\n");
      const userQueryBlock = claimFnBody.slice(
        claimFnBody.lastIndexOf("SELECT *", userQueryStart),
        claimFnBody.indexOf(";", userQueryStart),
      );
      expect(userQueryBlock).toContain("company_id = v_token.company_id");
      expect(userQueryBlock).toContain("is_active = TRUE");
      expect(userQueryBlock).toContain("id = v_token.user_id");

      const roleQueryStart = claimFnBody.indexOf("INTO v_has_sales_role");
      const roleQueryBlock = claimFnBody.slice(
        claimFnBody.lastIndexOf("SELECT EXISTS (", roleQueryStart),
        roleQueryStart,
      );
      expect(roleQueryBlock).toContain("ur.company_id = v_token.company_id");
      expect(roleQueryBlock).toContain("r.name = 'sales'");
    });

    it("role target berubah jadi non-sales -> claim ditolak (v_has_sales_role = FALSE memicu cabang gagal)", () => {
      expect(eligibilityIfStart).toBeGreaterThan(-1);
      expect(eligibilityBranch).toContain("NOT v_has_sales_role");
    });

    it("target dinonaktifkan setelah token diterbitkan -> claim ditolak (v_user_found = FALSE karena is_active = TRUE tidak lagi terpenuhi)", () => {
      expect(eligibilityBranch).toContain("NOT v_user_found");
    });

    it("tenant relation tidak cocok -> claim ditolak (v_user_found = FALSE karena company_id = v_token.company_id tidak lagi cocok, bukan payload Telegram)", () => {
      const userQueryStart = claimFnBody.indexOf("INTO v_user\n");
      const userQueryBlock = claimFnBody.slice(
        claimFnBody.lastIndexOf("SELECT *", userQueryStart),
        claimFnBody.indexOf(";", userQueryStart),
      );
      expect(userQueryBlock).toContain("company_id = v_token.company_id");
      expect(userQueryBlock).not.toMatch(/p_telegram/);
    });

    it("gagal eligibility TIDAK membocorkan penyebab -- outcome yang sama dgn kode invalid/kedaluwarsa, BUKAN outcome 'not_eligible' yang berbeda", () => {
      expect(eligibilityBranch).toContain("'invalid_or_expired'::TEXT");
      expect(eligibilityBranch).not.toContain("not_eligible");
    });

    it("eligibility check terjadi SEBELUM identity dibuat/diaktifkan, SEBELUM claimed_at ditulis, dan SEBELUM audit sukses", () => {
      const identityWriteIdx = claimFnBody.indexOf(
        "UPDATE public.telegram_identities\n    SET telegram_user_id",
      );
      const identityInsertIdx = claimFnBody.indexOf(
        "INSERT INTO public.telegram_identities (",
      );
      const claimedAtWriteIdx = claimFnBody.indexOf(
        "SET claimed_at = NOW()",
      );
      const successAuditIdx = claimFnBody.indexOf(
        "'telegram.identity_enrolled'",
      );

      expect(eligibilityIfStart).toBeGreaterThan(-1);
      expect(identityWriteIdx).toBeGreaterThan(-1);
      expect(identityInsertIdx).toBeGreaterThan(-1);
      expect(claimedAtWriteIdx).toBeGreaterThan(-1);
      expect(successAuditIdx).toBeGreaterThan(-1);

      expect(eligibilityIfStart).toBeLessThan(identityWriteIdx);
      expect(eligibilityIfStart).toBeLessThan(identityInsertIdx);
      expect(eligibilityIfStart).toBeLessThan(claimedAtWriteIdx);
      expect(eligibilityIfStart).toBeLessThan(successAuditIdx);
    });

    it("kegagalan eligibility tidak menghasilkan identity, claimed token, atau audit sukses -- hanya token pending yang di-revoke, lalu return langsung", () => {
      expect(eligibilityBranch).toContain(
        "UPDATE public.telegram_enrollment_tokens",
      );
      expect(eligibilityBranch).toContain("SET revoked_at = NOW()");
      expect(eligibilityBranch).not.toContain("telegram_identities");
      expect(eligibilityBranch).not.toContain("claimed_at = NOW()");
      expect(eligibilityBranch).not.toContain("'telegram.identity_enrolled'");
      expect(eligibilityBranch).not.toContain("INSERT INTO public.audit_logs");
      expect(eligibilityBranch.trim().endsWith("END IF;")).toBe(true);
    });

    it("token revoked/expired/claimed-oleh-akun-lain tetap invalid_or_expired (perilaku existing tidak berubah oleh corrective ini)", () => {
      expect(claimFnBody).toContain("v_token.revoked_at IS NOT NULL");
      expect(claimFnBody).toContain("v_token.expires_at <= NOW()");
      const claimedBranchStart = claimFnBody.indexOf(
        "IF v_token.claimed_at IS NOT NULL THEN",
      );
      expect(claimedBranchStart).toBeGreaterThan(-1);
      expect(claimedBranchStart).toBeLessThan(eligibilityIfStart);
    });

    it("signature dan return contract claim_telegram_salesman_identity tidak berubah", () => {
      expect(claimFnBody.slice(0, 400)).toContain(
        "p_token_hash TEXT,\n  p_telegram_chat_id BIGINT,\n  p_telegram_user_id BIGINT,\n  p_telegram_username TEXT DEFAULT NULL",
      );
      expect(claimFnBody.slice(0, 700)).toContain(
        "RETURNS TABLE(\n  result_outcome TEXT,\n  telegram_identity_id UUID,\n  result_company_id UUID,\n  result_user_id UUID,\n  result_user_full_name TEXT\n)",
      );
    });
  });
});
