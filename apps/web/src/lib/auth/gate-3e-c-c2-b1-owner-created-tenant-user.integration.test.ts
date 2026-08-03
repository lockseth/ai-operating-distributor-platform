// =============================================================================
// Gate 3E-C-C2-B1 (Owner-Created Tenant User Backend & Mandatory Password
// Change Contract) -- DB-backed, Postgres/Supabase NYATA (bukan mock).
// Membuktikan migration
// 20260911000001_gate_3e_c_c2_b1_owner_created_user_mandatory_password.sql
// (provision_owner_created_tenant_user(), complete_mandatory_password_change())
// terhadap kontrak gate: owner-only, allowlist role {admin, sales},
// tenant-scoped, atomic+compensating, must_change_password lifecycle
// server-enforced.
//
// Pola identik gate-3d-b2-atomic-owner-provisioning.integration.test.ts:
// setup lewat service-role client (bypass RLS, meniru actions.ts), RPC
// dipanggil lewat sesi anon-key sungguhan (signInWithPassword) supaya
// auth.uid() di dalam complete_mandatory_password_change() sungguh valid.
// provision_owner_created_tenant_user() sendiri dipanggil service-role
// (meniru SupabaseTenantUserRepository.provisionTenantUser()).
//
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

type ProvisionResultRow = { result_outcome: string };

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-C-C2-B1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-C-C2-B1: provision_owner_created_tenant_user() + complete_mandatory_password_change() (Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ecc2b1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let adminRoleId = "";
  let salesRoleId = "";
  let ownerRoleId = "";
  let superAdminRoleId = "";

  const createdAuthUserIds: string[] = [];
  const createdCompanyIds: string[] = [];

  async function createCompany(key: string): Promise<string> {
    const id = randomUUID();
    const { error } = await service.from("companies").insert({
      id,
      name: `Gate 3E-C-C2-B1 ${runTag} ${key}`,
      slug: `gate-3e-c-c2-b1-${runTag}-${key}`.toLowerCase(),
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

  /** Owner tenant sungguhan: auth user + public.users profile + user_roles(owner). */
  async function createTenantOwner(
    key: string,
    companyId: string,
    opts: { isActive?: boolean } = {}
  ): Promise<{ id: string; email: string; password: string }> {
    const owner = await createAuthUser(`${key}-owner`);
    const { error: profileErr } = await service.from("users").insert({
      id: owner.id,
      company_id: companyId,
      email: owner.email,
      full_name: `Itest Owner ${key}`,
      is_active: opts.isActive ?? true,
    });
    if (profileErr) throw new Error(`gagal buat profile owner ${key}: ${profileErr.message}`);
    const { error: roleErr } = await service.from("user_roles").insert({
      user_id: owner.id,
      role_id: ownerRoleId,
      company_id: companyId,
    });
    if (roleErr) throw new Error(`gagal assign role owner ${key}: ${roleErr.message}`);
    return owner;
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
      .select("id, company_id, email, full_name, is_active, must_change_password")
      .eq("id", userId)
      .maybeSingle();
    return data as { id: string; company_id: string; email: string; full_name: string; is_active: boolean; must_change_password: boolean } | null;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);
    const { data: roles } = await service.from("roles").select("id, name").is("company_id", null).in("name", ["admin", "sales", "owner", "super_admin"]);
    const byName = Object.fromEntries(((roles ?? []) as { id: string; name: string }[]).map((r) => [r.name, r.id]));
    adminRoleId = byName.admin;
    salesRoleId = byName.sales;
    ownerRoleId = byName.owner;
    superAdminRoleId = byName.super_admin;
    expect(adminRoleId).toBeTruthy();
    expect(salesRoleId).toBeTruthy();
    expect(ownerRoleId).toBeTruthy();
    expect(superAdminRoleId).toBeTruthy();
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("audit_logs").delete().in("company_id", createdCompanyIds);
    await service.from("user_roles").delete().in("user_id", createdAuthUserIds);
    await service.from("users").delete().in("id", createdAuthUserIds);
    await service.from("companies").delete().in("id", createdCompanyIds);
    for (const id of createdAuthUserIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1. Owner berhasil membuat user role admin -- profile+role+audit tercipta, must_change_password TRUE", async () => {
    const companyId = await createCompany("admin-ok");
    const owner = await createTenantOwner("admin-ok", companyId);
    const target = await createAuthUser("admin-ok-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: adminRoleId,
      p_full_name: "Admin Baru",
      p_email: target.email,
      p_phone: "0812-1111-2222",
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("provisioned");

    const row = await getUserRow(target.id);
    expect(row?.company_id).toBe(companyId);
    expect(row?.must_change_password).toBe(true);

    const { data: rolesFor } = await service.from("user_roles").select("role_id, assigned_by").eq("user_id", target.id);
    expect(rolesFor).toHaveLength(1);
    expect((rolesFor![0] as { role_id: string }).role_id).toBe(adminRoleId);
    expect((rolesFor![0] as { assigned_by: string }).assigned_by).toBe(owner.id);

    const { data: audit } = await service.from("audit_logs").select("action, new_data").eq("entity_id", target.id).eq("action", "tenant_user.created");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit![0])).not.toMatch(/password/i);
  });

  it("2. Owner berhasil membuat user role sales (regression check terhadap jalur lama tidak terganggu)", async () => {
    const companyId = await createCompany("sales-ok");
    const owner = await createTenantOwner("sales-ok", companyId);
    const target = await createAuthUser("sales-ok-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Sales Baru",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("provisioned");

    const { data: rolesFor } = await service.from("user_roles").select("role_id").eq("user_id", target.id);
    expect((rolesFor![0] as { role_id: string }).role_id).toBe(salesRoleId);
  });

  it("3. Role injection ditolak: mencoba assign role 'owner' via jalur ini -> invalid_role, zero persistence", async () => {
    const companyId = await createCompany("role-inject-owner");
    const owner = await createTenantOwner("role-inject-owner", companyId);
    const target = await createAuthUser("role-inject-owner-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: ownerRoleId,
      p_full_name: "Percobaan Owner",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("invalid_role");

    const row = await getUserRow(target.id);
    expect(row).toBeNull();
  });

  it("3b. Role injection ditolak: mencoba assign role 'super_admin' -> invalid_role, zero persistence", async () => {
    const companyId = await createCompany("role-inject-sa");
    const owner = await createTenantOwner("role-inject-sa", companyId);
    const target = await createAuthUser("role-inject-sa-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: superAdminRoleId,
      p_full_name: "Percobaan Super Admin",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("invalid_role");

    const row = await getUserRow(target.id);
    expect(row).toBeNull();
  });

  it("4. Non-owner (admin actor) ditolak -- forbidden, zero persistence", async () => {
    const companyId = await createCompany("non-owner-actor");
    const fakeActor = await createAuthUser("non-owner-actor-fake");
    await service.from("users").insert({ id: fakeActor.id, company_id: companyId, email: fakeActor.email, full_name: "Bukan Owner", is_active: true });
    await service.from("user_roles").insert({ user_id: fakeActor.id, role_id: adminRoleId, company_id: companyId });
    const target = await createAuthUser("non-owner-actor-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: fakeActor.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("forbidden");
    expect(await getUserRow(target.id)).toBeNull();
  });

  it("5. Owner NONAKTIF ditolak -- forbidden, zero persistence", async () => {
    const companyId = await createCompany("inactive-owner");
    const owner = await createTenantOwner("inactive-owner", companyId, { isActive: false });
    const target = await createAuthUser("inactive-owner-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("forbidden");
    expect(await getUserRow(target.id)).toBeNull();
  });

  it("6. Cross-tenant: owner tenant A tidak dapat membuat user untuk tenant B -- forbidden", async () => {
    const companyA = await createCompany("cross-a");
    const companyB = await createCompany("cross-b");
    const ownerA = await createTenantOwner("cross-a", companyA);
    const target = await createAuthUser("cross-target");

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: ownerA.id,
      p_company_id: companyB, // owner A mencoba menyasar tenant B
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("forbidden");
    expect(await getUserRow(target.id)).toBeNull();
  });

  it("7. auth user tidak valid (belum pernah dibuat) -> exception fail-closed, zero persistence", async () => {
    const companyId = await createCompany("invalid-auth-user");
    const owner = await createTenantOwner("invalid-auth-user", companyId);

    const { data, error } = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: randomUUID(), // tidak pernah ada di auth.users
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: "ghost@itest.test",
      p_phone: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("AODP_INVALID_AUTH_USER");
  });

  it("8. Duplicate profil (retry dengan user_id yang sama) -> unique_violation, tidak menimpa baris pertama", async () => {
    const companyId = await createCompany("duplicate-retry");
    const owner = await createTenantOwner("duplicate-retry", companyId);
    const target = await createAuthUser("duplicate-retry-target");

    const first = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Pertama",
      p_email: target.email,
      p_phone: null,
    });
    expect(first.error).toBeNull();

    const second = await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id, // user_id sama -- primary key sudah ada
      p_role_id: salesRoleId,
      p_full_name: "Kedua",
      p_email: target.email,
      p_phone: null,
    });
    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error!.code).toBe("23505");

    const row = await getUserRow(target.id);
    expect(row?.full_name).toBe("Pertama");
  });

  it("9. must_change_password lifecycle: user tidak dapat membersihkan flag-nya sendiri lewat direct REST update (column privilege)", async () => {
    const companyId = await createCompany("self-clear-attempt");
    const owner = await createTenantOwner("self-clear-attempt", companyId);
    const target = await createAuthUser("self-clear-attempt-target");
    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });

    const scopedTarget = await signInAs(target.email, target.password);
    const { error } = await scopedTarget.from("users").update({ must_change_password: false }).eq("id", target.id);
    expect(error).not.toBeNull();

    const row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);
  });

  it("10. must_change_password lifecycle: complete_mandatory_password_change() menolak selama password BELUM diganti", async () => {
    const companyId = await createCompany("not-yet-changed");
    const owner = await createTenantOwner("not-yet-changed", companyId);
    const target = await createAuthUser("not-yet-changed-target");
    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });

    const scopedTarget = await signInAs(target.email, target.password);
    const { data, error } = await scopedTarget.rpc("complete_mandatory_password_change");
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("password_not_yet_changed");

    const row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);
  });

  it("11. must_change_password lifecycle: SETELAH password sungguh diganti, complete_mandatory_password_change() membersihkan flag", async () => {
    const companyId = await createCompany("changed-ok");
    const owner = await createTenantOwner("changed-ok", companyId);
    const target = await createAuthUser("changed-ok-target");
    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });

    const scopedTarget = await signInAs(target.email, target.password);
    const { error: updateErr } = await scopedTarget.auth.updateUser({ password: randomUUID() });
    expect(updateErr).toBeNull();

    const { data, error } = await scopedTarget.rpc("complete_mandatory_password_change");
    expect(error).toBeNull();
    expect((data as ProvisionResultRow[])[0].result_outcome).toBe("cleared");

    const row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(false);

    // Idempotent: panggilan ulang setelah sukses -> already_cleared, bukan error.
    const { data: second } = await scopedTarget.rpc("complete_mandatory_password_change");
    expect((second as ProvisionResultRow[])[0].result_outcome).toBe("already_cleared");
  });

  it("12. must_change_password lifecycle: user B tidak dapat membersihkan flag milik user A (RPC tidak menerima parameter user_id)", async () => {
    const companyId = await createCompany("cannot-clear-other");
    const owner = await createTenantOwner("cannot-clear-other", companyId);
    const userA = await createAuthUser("cannot-clear-other-a");
    const userB = await createAuthUser("cannot-clear-other-b");

    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id, p_company_id: companyId, p_user_id: userA.id,
      p_role_id: salesRoleId, p_full_name: "User A", p_email: userA.email, p_phone: null,
    });
    await service.from("users").insert({ id: userB.id, company_id: companyId, email: userB.email, full_name: "User B", is_active: true });
    await service.from("user_roles").insert({ user_id: userB.id, role_id: salesRoleId, company_id: companyId });

    // User B mengganti PASSWORD-NYA SENDIRI lalu memanggil RPC -- hasilnya
    // (no_profile/already_cleared, karena B tidak pernah must_change_password)
    // TIDAK BOLEH mempengaruhi flag user A sama sekali.
    const scopedB = await signInAs(userB.email, userB.password);
    await scopedB.auth.updateUser({ password: randomUUID() });
    await scopedB.rpc("complete_mandatory_password_change");

    const rowA = await getUserRow(userA.id);
    expect(rowA?.must_change_password).toBe(true);
  });

  it("13. user_metadata spoofing tidak berpengaruh: mengubah user_metadata.role setelah provisioning tidak mengubah role tersimpan", async () => {
    const companyId = await createCompany("metadata-spoof");
    const owner = await createTenantOwner("metadata-spoof", companyId);
    const target = await createAuthUser("metadata-spoof-target");
    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });

    await service.auth.admin.updateUserById(target.id, { user_metadata: { role: "owner", company_id: "attacker-company" } });

    const { data: rolesFor } = await service.from("user_roles").select("role_id").eq("user_id", target.id);
    expect((rolesFor![0] as { role_id: string }).role_id).toBe(salesRoleId);
    const row = await getUserRow(target.id);
    expect(row?.company_id).toBe(companyId);
  });

  it("14. provisioned_password_hash tidak pernah terbaca lewat SELECT authenticated (column privilege)", async () => {
    const companyId = await createCompany("hash-not-readable");
    const owner = await createTenantOwner("hash-not-readable", companyId);
    const target = await createAuthUser("hash-not-readable-target");
    await service.rpc("provision_owner_created_tenant_user", {
      p_actor_id: owner.id,
      p_company_id: companyId,
      p_user_id: target.id,
      p_role_id: salesRoleId,
      p_full_name: "Target",
      p_email: target.email,
      p_phone: null,
    });

    const scopedTarget = await signInAs(target.email, target.password);
    const { error } = await scopedTarget.from("users").select("provisioned_password_hash").eq("id", target.id);
    expect(error).not.toBeNull();
  });
});
