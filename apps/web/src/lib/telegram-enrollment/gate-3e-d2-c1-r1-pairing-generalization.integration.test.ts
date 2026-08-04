// =============================================================================
// Gate 3E-D2-C1-R1 -- DB-backed, Postgres/Supabase LOKAL (bukan mock, bukan
// hosted). Membuktikan issue_telegram_salesman_enrollment() dan
// revoke_telegram_salesman_identity() (migration 20260912000001, Gate
// 3E-D1-R1) benar-benar berperilaku sesuai kontrak generalisasi target
// {owner, admin, sales} pada level RPC nyata -- bukan hanya pattern-match
// teks migration seperti security.test.ts / pairing-generalization.test.ts.
//
// Kenapa dibutuhkan: audit Gate 3E-D2-C1 menemukan RPC sudah digeneralisasi
// sejak 20260912000001, tetapi UI (dashboard/users/page.tsx) masih hanya
// merender kontrol pairing untuk baris role sales -- sehingga jalur
// owner/admin belum pernah benar-benar dilatih end-to-end. Test ini
// melengkapi bukti behavioral untuk jalur baru itu: issuance lintas role
// eligible, actor-forbidden, target di luar allowlist, cross-tenant,
// target nonaktif, one-time/expiry, claim, dan revoke -- semuanya terhadap
// database lokal sungguhan (pola identik
// gate-3e-d2-b-telegram-self-service-password-reset.integration.test.ts).
//
// TIDAK menyentuh project Supabase hosted, TIDAK mengirim pesan Telegram
// nyata, TIDAK melakukan pairing/reset password nyata pada akun manapun.
// Skip graceful jika kredensial Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createClient as createServiceClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID, randomBytes } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

type IssueOutcomeRow = { result_outcome: string; enrollment_token_id: string | null };
type RevokeOutcomeRow = { result_outcome: string; telegram_identity_id: string | null };
type ClaimOutcomeRow = { result_outcome: string; telegram_identity_id: string | null };

function freshTokenHash(): string {
  return randomBytes(32).toString("hex");
}

function ttlExpiresAt(minutes = 30): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn(
    "Gate 3E-D2-C1-R1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).",
  );
}

describeIfDb(
  "Gate 3E-D2-C1-R1: issue/revoke_telegram_salesman_enrollment target generalization (Postgres lokal nyata)",
  () => {
    let service: SupabaseClient;
    const runTag = `itest-g3ed2c1r1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    let ownerRoleId = "";
    let adminRoleId = "";
    let salesRoleId = "";
    let warehouseRoleId = "";

    const createdAuthUserIds: string[] = [];
    const createdCompanyIds: string[] = [];

    async function createCompany(key: string): Promise<string> {
      const id = randomUUID();
      const { error } = await service.from("companies").insert({
        id,
        name: `Gate 3E-D2-C1-R1 ${runTag} ${key}`,
        slug: `gate-3e-d2-c1-r1-${runTag}-${key}`.toLowerCase(),
      });
      if (error) throw new Error(`gagal buat company ${key}: ${error.message}`);
      createdCompanyIds.push(id);
      return id;
    }

    async function createTenantUser(
      key: string,
      companyId: string,
      roleId: string,
      opts: { isActive?: boolean } = {},
    ): Promise<{ id: string; email: string }> {
      const email = `${runTag}-${key}@itest.test`;
      const password = randomUUID();
      const { data, error } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`gagal buat auth user ${key}: ${error?.message}`);
      createdAuthUserIds.push(data.user.id);

      const { error: profileErr } = await service.from("users").insert({
        id: data.user.id,
        company_id: companyId,
        email,
        full_name: `Itest ${key}`,
        is_active: opts.isActive ?? true,
      });
      if (profileErr) throw new Error(`gagal buat profile ${key}: ${profileErr.message}`);

      if (roleId) {
        const { error: roleErr } = await service
          .from("user_roles")
          .insert({ user_id: data.user.id, role_id: roleId, company_id: companyId });
        if (roleErr) throw new Error(`gagal assign role ${key}: ${roleErr.message}`);
      }
      return { id: data.user.id, email };
    }

    async function pendingTokenRow(userId: string) {
      const { data } = await service
        .from("telegram_enrollment_tokens")
        .select("id, revoked_at, claimed_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      return data as { id: string; revoked_at: string | null; claimed_at: string | null }[];
    }

    beforeAll(async () => {
      service = createServiceClient(env!.url, env!.serviceRoleKey);
      const { data: roles } = await service
        .from("roles")
        .select("id, name")
        .is("company_id", null)
        .in("name", ["owner", "admin", "sales", "warehouse"]);
      const byName = Object.fromEntries(
        ((roles ?? []) as { id: string; name: string }[]).map((r) => [r.name, r.id]),
      );
      ownerRoleId = byName.owner;
      adminRoleId = byName.admin;
      salesRoleId = byName.sales;
      warehouseRoleId = byName.warehouse;
      expect(ownerRoleId).toBeTruthy();
      expect(adminRoleId).toBeTruthy();
      expect(salesRoleId).toBeTruthy();
      expect(warehouseRoleId).toBeTruthy();
    }, 30000);

    afterAll(async () => {
      if (!service) return;
      await service.from("audit_logs").delete().in("company_id", createdCompanyIds);
      await service.from("telegram_enrollment_tokens").delete().in("user_id", createdAuthUserIds);
      await service.from("telegram_identities").delete().in("user_id", createdAuthUserIds);
      await service.from("user_roles").delete().in("user_id", createdAuthUserIds);
      await service.from("users").delete().in("id", createdAuthUserIds);
      await service.from("companies").delete().in("id", createdCompanyIds);
      for (const id of createdAuthUserIds) await service.auth.admin.deleteUser(id).catch(() => {});
    }, 60000);

    it("1. Owner menerbitkan pairing token untuk target Owner (dirinya sendiri) -- issued", async () => {
      const companyId = await createCompany("owner-self");
      const owner = await createTenantUser("owner-self-actor", companyId, ownerRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: owner.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");
      expect((data as IssueOutcomeRow[])[0].enrollment_token_id).toBeTruthy();
    });

    it("2. Owner menerbitkan pairing token untuk target Admin -- issued", async () => {
      const companyId = await createCompany("owner-admin");
      const owner = await createTenantUser("owner-admin-actor", companyId, ownerRoleId);
      const admin = await createTenantUser("owner-admin-target", companyId, adminRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: admin.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");
    });

    it("3. Owner tetap dapat memasangkan target Sales -- issued (regresi tidak berubah)", async () => {
      const companyId = await createCompany("owner-sales");
      const owner = await createTenantUser("owner-sales-actor", companyId, ownerRoleId);
      const sales = await createTenantUser("owner-sales-target", companyId, salesRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: sales.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");
    });

    it("4. Actor non-Owner (Admin) tidak dapat menerbitkan token -- forbidden", async () => {
      const companyId = await createCompany("non-owner-actor");
      const admin = await createTenantUser("non-owner-actor-admin", companyId, adminRoleId);
      const sales = await createTenantUser("non-owner-actor-target", companyId, salesRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: sales.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: admin.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("forbidden");
      expect((data as IssueOutcomeRow[])[0].enrollment_token_id).toBeNull();
    });

    it("5. Target di luar allowlist {owner,admin,sales} (mis. warehouse) ditolak -- not_eligible", async () => {
      const companyId = await createCompany("out-of-allowlist");
      const owner = await createTenantUser("out-of-allowlist-actor", companyId, ownerRoleId);
      const warehouse = await createTenantUser("out-of-allowlist-target", companyId, warehouseRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: warehouse.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("not_eligible");
    });

    it("6. Target di tenant lain (cross-tenant) ditolak -- not_eligible", async () => {
      const companyA = await createCompany("cross-tenant-a");
      const companyB = await createCompany("cross-tenant-b");
      const ownerA = await createTenantUser("cross-tenant-owner-a", companyA, ownerRoleId);
      const targetB = await createTenantUser("cross-tenant-target-b", companyB, adminRoleId);

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyA,
        p_user_id: targetB.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: ownerA.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("not_eligible");
    });

    it("7. Target nonaktif ditolak -- not_eligible", async () => {
      const companyId = await createCompany("inactive-target");
      const owner = await createTenantUser("inactive-target-actor", companyId, ownerRoleId);
      const inactiveAdmin = await createTenantUser(
        "inactive-target-admin",
        companyId,
        adminRoleId,
        { isActive: false },
      );

      const { data, error } = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: inactiveAdmin.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect(error).toBeNull();
      expect((data as IssueOutcomeRow[])[0].result_outcome).toBe("not_eligible");
    });

    it("8. One-time: issuance kedua untuk target yang sama otomatis me-revoke token pending sebelumnya", async () => {
      const companyId = await createCompany("one-time");
      const owner = await createTenantUser("one-time-actor", companyId, ownerRoleId);
      const admin = await createTenantUser("one-time-target", companyId, adminRoleId);

      const first = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: admin.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect((first.data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");
      const firstTokenId = (first.data as IssueOutcomeRow[])[0].enrollment_token_id;

      const second = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: admin.id,
        p_token_hash: freshTokenHash(),
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect((second.data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");

      const rows = await pendingTokenRow(admin.id);
      const firstRow = rows.find((r) => r.id === firstTokenId);
      expect(firstRow?.revoked_at).not.toBeNull();
    });

    it("9. Claim: token untuk target Owner dapat diklaim (identity aktif dibuat), lalu replay dengan hash sama ditolak", async () => {
      const companyId = await createCompany("claim-owner");
      const owner = await createTenantUser("claim-owner-actor", companyId, ownerRoleId);
      const tokenHash = freshTokenHash();

      const issue = await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: owner.id,
        p_token_hash: tokenHash,
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      expect((issue.data as IssueOutcomeRow[])[0].result_outcome).toBe("issued");

      const claim = await service.rpc("claim_telegram_salesman_identity", {
        p_token_hash: tokenHash,
        p_telegram_chat_id: 920_001,
        p_telegram_user_id: 920_001,
        p_telegram_username: null,
      });
      expect(claim.error).toBeNull();
      expect((claim.data as ClaimOutcomeRow[])[0].result_outcome).toBe("claimed");
      expect((claim.data as ClaimOutcomeRow[])[0].telegram_identity_id).toBeTruthy();

      const identity = await service
        .from("telegram_identities")
        .select("user_id, company_id, is_active")
        .eq("user_id", owner.id)
        .maybeSingle();
      expect(identity.data?.is_active).toBe(true);
      expect(identity.data?.company_id).toBe(companyId);

      // Replay: hash yang sama sudah claimed_at terisi -> tidak boleh bisa diklaim ulang.
      const replay = await service.rpc("claim_telegram_salesman_identity", {
        p_token_hash: tokenHash,
        p_telegram_chat_id: 920_002,
        p_telegram_user_id: 920_002,
        p_telegram_username: null,
      });
      expect(replay.error).toBeNull();
      expect((replay.data as ClaimOutcomeRow[])[0].result_outcome).toBe("invalid_or_expired");
    });

    it("10. Revoke tetap bekerja untuk target Admin (bukan hanya Sales) -- revoked", async () => {
      const companyId = await createCompany("revoke-admin");
      const owner = await createTenantUser("revoke-admin-actor", companyId, ownerRoleId);
      const admin = await createTenantUser("revoke-admin-target", companyId, adminRoleId);
      const tokenHash = freshTokenHash();

      await service.rpc("issue_telegram_salesman_enrollment", {
        p_company_id: companyId,
        p_user_id: admin.id,
        p_token_hash: tokenHash,
        p_expires_at: ttlExpiresAt(),
        p_created_by: owner.id,
      });
      await service.rpc("claim_telegram_salesman_identity", {
        p_token_hash: tokenHash,
        p_telegram_chat_id: 920_010,
        p_telegram_user_id: 920_010,
        p_telegram_username: null,
      });

      const revoke = await service.rpc("revoke_telegram_salesman_identity", {
        p_company_id: companyId,
        p_user_id: admin.id,
        p_revoked_by: owner.id,
      });
      expect(revoke.error).toBeNull();
      expect((revoke.data as RevokeOutcomeRow[])[0].result_outcome).toBe("revoked");

      const identity = await service
        .from("telegram_identities")
        .select("is_active")
        .eq("user_id", admin.id)
        .maybeSingle();
      expect(identity.data?.is_active).toBe(false);
    });
  },
);
