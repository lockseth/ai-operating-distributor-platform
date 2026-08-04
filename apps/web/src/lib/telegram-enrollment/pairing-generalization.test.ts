import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260912000001_gate_3e_d1_r1_telegram_identity_pairing_generalization.sql",
  ),
  "utf8",
);
const workflow = readFileSync(
  path.resolve(__dirname, "../sales-orders/workflow.ts"),
  "utf8",
);
const route = readFileSync(
  path.resolve(
    __dirname,
    "../../app/api/webhooks/telegram/route.ts",
  ),
  "utf8",
);
const repository = readFileSync(
  path.resolve(__dirname, "../sales-orders/repository.ts"),
  "utf8",
);

describe("Gate 3E-D1-R1: pairing generalization (database)", () => {
  it("issue/claim/revoke tetap CREATE OR REPLACE atas routine yang sama (bukan RPC/tabel baru)", () => {
    for (const routine of [
      "issue_telegram_salesman_enrollment",
      "claim_telegram_salesman_identity",
      "revoke_telegram_salesman_identity",
    ]) {
      expect(migration).toContain(
        `CREATE OR REPLACE FUNCTION public.${routine}`,
      );
    }
    expect(migration.match(/SECURITY DEFINER/g)?.length).toBe(3);
    expect(migration).toContain("FROM PUBLIC, anon, authenticated");
    expect(migration.match(/TO service_role/g)?.length).toBe(3);
  });

  it("target eligibility digeneralisasi ke {owner, admin, sales} pada ketiga routine", () => {
    // 3 pemakaian fungsional (issue/revoke/claim) + 1 dalam komentar header
    // yang menjelaskan perubahan (lihat top-of-file rationale) = 4.
    expect(
      migration.match(/r\.name IN \('owner','admin','sales'\)/g)?.length,
    ).toBe(4);
    // Predikat restriktif lama (hanya 'sales' untuk TARGET) sudah tidak ada
    // sama sekali di migration ini.
    expect(migration).not.toContain("r.name = 'sales'");
  });

  it("actor gate issue/revoke TETAP owner-only (Gate 1C tidak diregresi oleh generalisasi target)", () => {
    expect(migration.match(/AND r\.name = 'owner'/g)?.length).toBe(2);
  });

  it("signature ketiga routine tidak berubah", () => {
    expect(migration).toContain(
      "issue_telegram_salesman_enrollment(\n  p_company_id UUID,\n  p_user_id UUID,\n  p_token_hash TEXT,\n  p_expires_at TIMESTAMPTZ,\n  p_created_by UUID\n)",
    );
    expect(migration).toContain(
      "revoke_telegram_salesman_identity(\n  p_company_id UUID,\n  p_user_id UUID,\n  p_revoked_by UUID\n)",
    );
    expect(migration).toContain(
      "claim_telegram_salesman_identity(\n  p_token_hash TEXT,\n  p_telegram_chat_id BIGINT,\n  p_telegram_user_id BIGINT,\n  p_telegram_username TEXT DEFAULT NULL\n)",
    );
  });

  it("revoke: target-role check tetap SEBELUM lookup identity, dan tetap tidak mensyaratkan users.is_active", () => {
    const revokeStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.revoke_telegram_salesman_identity",
    );
    const claimStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.claim_telegram_salesman_identity",
    );
    const revokeBody = migration.slice(revokeStart, claimStart);
    const targetCheckIdx = revokeBody.indexOf("v_target_role_eligible");
    const identityLookupIdx = revokeBody.indexOf("INTO v_identity");
    expect(targetCheckIdx).toBeGreaterThan(-1);
    expect(targetCheckIdx).toBeLessThan(identityLookupIdx);

    const queryEnd = revokeBody.indexOf("INTO v_target_role_eligible");
    const queryStart = revokeBody.lastIndexOf("SELECT EXISTS (", queryEnd);
    const targetQuery = revokeBody.slice(queryStart, queryEnd);
    expect(targetQuery).not.toContain("public.users");
    expect(targetQuery).not.toContain("is_active");
  });

  it("claim: eligibility re-check tetap SEBELUM identity/claimed_at/audit sukses (Gate 1C corrective dipertahankan)", () => {
    const claimStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.claim_telegram_salesman_identity",
    );
    const claimBody = migration.slice(claimStart);
    const eligibilityIdx = claimBody.indexOf(
      "IF NOT v_user_found OR NOT v_has_eligible_role THEN",
    );
    const identityInsertIdx = claimBody.indexOf(
      "INSERT INTO public.telegram_identities (",
    );
    const claimedAtWriteIdx = claimBody.indexOf("SET claimed_at = NOW()");
    const successAuditIdx = claimBody.indexOf("'telegram.identity_enrolled'");

    expect(eligibilityIdx).toBeGreaterThan(-1);
    expect(eligibilityIdx).toBeLessThan(identityInsertIdx);
    expect(eligibilityIdx).toBeLessThan(claimedAtWriteIdx);
    expect(eligibilityIdx).toBeLessThan(successAuditIdx);

    // Ineligible-at-claim tetap dinormalisasi ke outcome aman yang sama
    // dengan kode invalid/kedaluwarsa -- bukan outcome pembeda baru.
    const eligibilityEnd =
      claimBody.indexOf("END IF;", eligibilityIdx) + "END IF;".length;
    const eligibilityBranch = claimBody.slice(eligibilityIdx, eligibilityEnd);
    expect(eligibilityBranch).toContain("'invalid_or_expired'::TEXT");
    expect(eligibilityBranch).not.toContain("not_eligible");
  });
});

describe("Gate 3E-D1-R1: capability separation (application layer)", () => {
  it("SalesOrderTelegramRepository mendeklarasikan hasSalesOrderCapability sebagai kontrak eksplisit", () => {
    expect(repository).toContain("hasSalesOrderCapability(");
    expect(repository).toContain("hasTelegramCapability(roles, \"sales.order.telegram\")");
  });

  it("workflow.ts (processTelegramUpdate) menolak identity yang di-resolve tapi tidak eligible sales.order.telegram, SEBELUM masuk alur Delivery/Order", () => {
    const gateIdx = workflow.indexOf("hasSalesOrderCapability(");
    const deliveryDispatchIdx = workflow.indexOf(
      "deps.deliveryRepository.getConversationState(",
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(deliveryDispatchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(deliveryDispatchIdx);
    expect(workflow).toContain('rejectionReason: "capability_denied_sales_order_telegram"');
    // Balasan ke pengirim disamakan dengan unregistered -- tidak membocorkan
    // bahwa chat ini sebenarnya paired.
    expect(workflow).toContain("buildUnregisteredUserReply()");
  });

  it("route.ts menggate KEDUA titik resolveIdentity pre-dispatch (callback_query dan text) -- bukan hanya jalur bawah lewat processTelegramUpdate", () => {
    expect(route.match(/hasSalesOrderCapability\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
