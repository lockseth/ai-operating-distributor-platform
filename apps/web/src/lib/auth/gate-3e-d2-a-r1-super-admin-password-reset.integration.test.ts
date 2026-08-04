// =============================================================================
// Gate 3E-D2-A-R1 (Secure Super Admin Tenant-User Password Reset) -- DB-backed,
// Postgres/Supabase NYATA (bukan mock). Membuktikan migration
// 20260913000001_gate_3e_d2_a_r1_super_admin_tenant_user_password_reset.sql
// (super_admin_begin/finalize/fail_tenant_user_password_reset()) terhadap
// kontrak gate: super_admin-only, allowlist target {owner,admin,sales},
// target super_admin selalu ditolak, fail-closed sebelum Auth API dipanggil,
// idempotency in-flight per target, dan interop dengan
// complete_mandatory_password_change() (20260911000001) yang TIDAK diubah
// sama sekali oleh migration ini.
//
// Pola identik gate-3e-c-c2-b1-owner-created-tenant-user.integration.test.ts.
// Skip graceful jika kredensial Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

type OutcomeRow = { result_outcome: string; target_email?: string | null; target_company_id?: string | null };

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-D2-A-R1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D2-A-R1: super_admin_{begin,finalize,fail}_tenant_user_password_reset() (Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed2ar1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let ownerRoleId = "";
  let adminRoleId = "";
  let salesRoleId = "";
  let superAdminRoleId = "";

  const createdAuthUserIds: string[] = [];
  const createdCompanyIds: string[] = [];

  async function createCompany(key: string): Promise<string> {
    const id = randomUUID();
    const { error } = await service.from("companies").insert({
      id,
      name: `Gate 3E-D2-A-R1 ${runTag} ${key}`,
      slug: `gate-3e-d2-a-r1-${runTag}-${key}`.toLowerCase(),
    });
    if (error) throw new Error(`gagal buat company ${key}: ${error.message}`);
    createdCompanyIds.push(id);
    return id;
  }

  async function createAuthUser(key: string): Promise<{ id: string; email: string; password: string }> {
    const email = `${runTag}-${key}@itest.test`;
    const password = randomUUID();
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${key}: ${error?.message}`);
    createdAuthUserIds.push(data.user.id);
    return { id: data.user.id, email, password };
  }

  async function createTenantUser(
    key: string,
    companyId: string,
    roleId: string,
    opts: { isActive?: boolean } = {}
  ): Promise<{ id: string; email: string; password: string }> {
    const u = await createAuthUser(key);
    const { error: profileErr } = await service.from("users").insert({
      id: u.id,
      company_id: companyId,
      email: u.email,
      full_name: `Itest ${key}`,
      is_active: opts.isActive ?? true,
    });
    if (profileErr) throw new Error(`gagal buat profile ${key}: ${profileErr.message}`);
    const { error: roleErr } = await service.from("user_roles").insert({ user_id: u.id, role_id: roleId, company_id: companyId });
    if (roleErr) throw new Error(`gagal assign role ${key}: ${roleErr.message}`);
    return u;
  }

  async function signInAs(email: string, password: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`gagal sign-in ${email}: ${error.message}`);
    return scoped;
  }

  async function getUserRow(userId: string) {
    const { data } = await service
      .from("users")
      .select("id, company_id, email, is_active, must_change_password")
      .eq("id", userId)
      .maybeSingle();
    return data as { id: string; company_id: string; email: string; is_active: boolean; must_change_password: boolean } | null;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);
    const { data: roles } = await service.from("roles").select("id, name").is("company_id", null).in("name", ["owner", "admin", "sales", "super_admin"]);
    const byName = Object.fromEntries(((roles ?? []) as { id: string; name: string }[]).map((r) => [r.name, r.id]));
    ownerRoleId = byName.owner;
    adminRoleId = byName.admin;
    salesRoleId = byName.sales;
    superAdminRoleId = byName.super_admin;
    expect(ownerRoleId).toBeTruthy();
    expect(adminRoleId).toBeTruthy();
    expect(salesRoleId).toBeTruthy();
    expect(superAdminRoleId).toBeTruthy();
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("tenant_user_password_reset_operations").delete().in("actor_id", createdAuthUserIds);
    await service.from("audit_logs").delete().in("company_id", createdCompanyIds);
    await service.from("user_roles").delete().in("user_id", createdAuthUserIds);
    await service.from("users").delete().in("id", createdAuthUserIds);
    await service.from("companies").delete().in("id", createdCompanyIds);
    for (const id of createdAuthUserIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1. Alur penuh: begin -> auth update -> finalize -> mandatory-change lifecycle konsisten dengan complete_mandatory_password_change() existing", async () => {
    const companyId = await createCompany("happy");
    const superAdmin = await createTenantUser("happy-sa", companyId, superAdminRoleId);
    const target = await createTenantUser("happy-target", companyId, ownerRoleId);
    const operationId = randomUUID();

    const begin = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: operationId,
      p_actor_id: superAdmin.id,
      p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as OutcomeRow[])[0].result_outcome).toBe("db_committed");

    let row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);
    expect(row?.company_id).toBe(companyId); // company tidak berubah

    const newTempPassword = randomUUID();
    const authUpdate = await service.auth.admin.updateUserById(target.id, { password: newTempPassword });
    expect(authUpdate.error).toBeNull();

    const finalize = await service.rpc("super_admin_finalize_tenant_user_password_reset", {
      p_operation_id: operationId,
      p_actor_id: superAdmin.id,
      p_target_user_id: target.id,
    });
    expect(finalize.error).toBeNull();
    expect((finalize.data as OutcomeRow[])[0].result_outcome).toBe("succeeded");

    row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);

    // Sesi target sendiri, sebelum benar-benar ganti password -> tetap
    // terkunci (self-heal get-user.ts akan redirect ke /reset-password).
    const targetSession = await signInAs(target.email, newTempPassword);
    const before = await targetSession.rpc("complete_mandatory_password_change");
    expect((before.data as { result_outcome: string }[])[0]?.result_outcome).toBe("password_not_yet_changed");

    // Target sungguh mengganti password sendiri (alur reset-password-form.tsx existing).
    const finalPassword = randomUUID();
    const updateSelf = await targetSession.auth.updateUser({ password: finalPassword });
    expect(updateSelf.error).toBeNull();

    const after = await targetSession.rpc("complete_mandatory_password_change");
    expect((after.data as { result_outcome: string }[])[0]?.result_outcome).toBe("cleared");

    row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(false);

    // Password sementara (hasil reset admin) TIDAK LAGI berfungsi setelah target ganti sendiri.
    const oldStillWorks = await createServiceClient(env!.url, env!.anonKey).auth.signInWithPassword({
      email: target.email,
      password: newTempPassword,
    });
    expect(oldStillWorks.error).not.toBeNull();

    const audit = await service.from("audit_logs").select("action, new_data").eq("entity_id", target.id).in("action", [
      "tenant_user.password_reset_started",
      "tenant_user.password_reset_completed",
    ]);
    expect(audit.data).toHaveLength(2);
    expect(JSON.stringify(audit.data)).not.toMatch(/password/i);
  });

  it("2. Actor bukan super_admin ditolak -- forbidden, zero mutation", async () => {
    const companyId = await createCompany("non-sa-actor");
    const fakeActor = await createTenantUser("non-sa-actor-fake", companyId, adminRoleId);
    const target = await createTenantUser("non-sa-actor-target", companyId, ownerRoleId);

    const begin = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: fakeActor.id,
      p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as OutcomeRow[])[0].result_outcome).toBe("forbidden");
    expect((await getUserRow(target.id))?.must_change_password).toBe(false);
  });

  it("3. Target super_admin ditolak mutlak -- target_forbidden_super_admin, zero mutation", async () => {
    const companyId = await createCompany("target-sa");
    const superAdmin = await createTenantUser("target-sa-actor", companyId, superAdminRoleId);
    const otherSuperAdmin = await createTenantUser("target-sa-target", companyId, superAdminRoleId);

    const begin = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: superAdmin.id,
      p_target_user_id: otherSuperAdmin.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as OutcomeRow[])[0].result_outcome).toBe("target_forbidden_super_admin");
    expect((await getUserRow(otherSuperAdmin.id))?.must_change_password).toBe(false);
  });

  it("4. Target nonaktif ditolak -- target_inactive, zero mutation", async () => {
    const companyId = await createCompany("target-inactive");
    const superAdmin = await createTenantUser("target-inactive-actor", companyId, superAdminRoleId);
    const target = await createTenantUser("target-inactive-target", companyId, salesRoleId, { isActive: false });

    const begin = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: superAdmin.id,
      p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as OutcomeRow[])[0].result_outcome).toBe("target_inactive");
  });

  it("5. Dua reset in-flight pada target yang sama -- yang kedua ditolak already_in_progress (partial unique index sungguhan)", async () => {
    const companyId = await createCompany("in-flight");
    const superAdmin = await createTenantUser("in-flight-actor", companyId, superAdminRoleId);
    const target = await createTenantUser("in-flight-target", companyId, adminRoleId);

    const first = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: superAdmin.id,
      p_target_user_id: target.id,
    });
    expect((first.data as OutcomeRow[])[0].result_outcome).toBe("db_committed");

    const second = await service.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: superAdmin.id,
      p_target_user_id: target.id,
    });
    expect(second.error).toBeNull();
    expect((second.data as OutcomeRow[])[0].result_outcome).toBe("already_in_progress");
  });

  it("6. anon/authenticated tidak bisa memanggil RPC secara langsung (hanya service_role)", async () => {
    const anon = createServiceClient(env!.url, env!.anonKey);
    const { error } = await anon.rpc("super_admin_begin_tenant_user_password_reset", {
      p_operation_id: randomUUID(),
      p_actor_id: randomUUID(),
      p_target_user_id: randomUUID(),
    });
    expect(error).not.toBeNull();
  });
});
