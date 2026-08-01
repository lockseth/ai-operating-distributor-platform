// =============================================================================
// Gate 3D-B2 (Atomic Fail-Closed Owner Provisioning RPC) -- DB-backed, Postgres/
// Supabase NYATA (bukan mock). Membuktikan migration
// 20260907000001_gate_3d_b2_atomic_owner_provisioning_rpc.sql
// (public.provision_first_owner()) terhadap kontrak
// docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
// (§5.A, §7a step 2) dan Gate 3D-B2 test obligations.
//
// Semua panggilan RPC lewat sesi Supabase Auth SUNGGUHAN (anon-key client +
// signInWithPassword), BUKAN service-role -- ini persis pola pemanggilan yang
// akan dipakai signup UI (Gate 3D-B3): identitas caller HARUS berasal dari
// auth.uid() sesi PostgREST sungguhan, bukan parameter/actor-id yang
// disuntikkan test. Verifikasi state (company/profile/role/audit) memakai
// service-role client (bypass RLS) supaya bisa memeriksa hasil apa adanya.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan gate-3d-b1-single-owner-enforcement.integration.test.ts.
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

type ProvisionResultRow = { result_outcome: string; result_company_id: string; result_user_id: string };

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3D-B2 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3D-B2: provision_first_owner() atomic fail-closed owner provisioning RPC (Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3db2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let ownerRoleId = "";

  const createdAuthUserIds: string[] = [];
  const createdCompanyIds: string[] = [];

  async function createAuthUser(key: string, metadata?: Record<string, unknown>): Promise<{ id: string; email: string; password: string }> {
    const email = `${runTag}-${key}@itest.test`;
    const password = randomUUID();
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata });
    if (error || !data.user) throw new Error(`gagal buat auth user ${key}: ${error?.message}`);
    createdAuthUserIds.push(data.user.id);
    return { id: data.user.id, email, password };
  }

  async function signInAs(email: string, password: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`gagal sign-in ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);
    const { data: ownerRole } = await service.from("roles").select("id").eq("name", "owner").is("company_id", null).single();
    ownerRoleId = (ownerRole as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("audit_logs").delete().in("company_id", createdCompanyIds);
    await service.from("user_roles").delete().in("user_id", createdAuthUserIds);
    await service.from("users").delete().in("id", createdAuthUserIds);
    await service.from("companies").delete().in("id", createdCompanyIds);
    for (const id of createdAuthUserIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1-2. Caller authenticated valid berhasil diprovisi sebagai owner; company/profile/role/audit tercipta lengkap & konsisten", async () => {
    const user = await createAuthUser("success1");
    const scoped = await signInAs(user.email, user.password);

    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT Sukses ${runTag}`,
      p_full_name: "Budi Owner",
      p_phone: "0812-3456-7890",
    });
    expect(error).toBeNull();
    const row = (data as ProvisionResultRow[])[0];
    expect(row.result_outcome).toBe("provisioned");
    expect(row.result_user_id).toBe(user.id);
    createdCompanyIds.push(row.result_company_id);

    const { data: companies } = await service.from("companies").select("id, name, is_active, subscription_plan").eq("id", row.result_company_id);
    expect(companies).toHaveLength(1);
    expect(companies![0].name).toBe(`PT Sukses ${runTag}`);
    expect(companies![0].is_active).toBe(true);

    const { data: profile } = await service
      .from("users")
      .select("id, company_id, email, full_name, phone, is_active")
      .eq("id", user.id)
      .single();
    expect((profile as { company_id: string }).company_id).toBe(row.result_company_id);
    expect((profile as { email: string }).email).toBe(user.email);
    expect((profile as { full_name: string }).full_name).toBe("Budi Owner");
    expect((profile as { phone: string }).phone).toBe("0812-3456-7890");
    expect((profile as { is_active: boolean }).is_active).toBe(true);

    const { data: roles } = await service.from("user_roles").select("role_id, company_id, assigned_by").eq("user_id", user.id);
    expect(roles).toHaveLength(1);
    expect((roles![0] as { role_id: string }).role_id).toBe(ownerRoleId);
    expect((roles![0] as { company_id: string }).company_id).toBe(row.result_company_id);

    const { data: auditRows } = await service
      .from("audit_logs")
      .select("action, entity_type, entity_id, user_id")
      .eq("company_id", row.result_company_id);
    expect(auditRows).toHaveLength(1);
    expect((auditRows![0] as { action: string }).action).toBe("tenant.first_owner_provisioned");
    expect((auditRows![0] as { user_id: string }).user_id).toBe(user.id);
  });

  it("3. Caller anonymous (tidak authenticated) DITOLAK di level privilege (EXECUTE tidak di-GRANT ke anon) -- zero persistence", async () => {
    const anonClient = createServiceClient(env!.url, env!.anonKey);
    const { data, error } = await anonClient.rpc("provision_first_owner", {
      p_company_name: `PT Anon ${runTag}`,
      p_full_name: "Anon User",
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(data).toBeNull();

    const { data: companies } = await service.from("companies").select("id").eq("name", `PT Anon ${runTag}`);
    expect(companies ?? []).toHaveLength(0);
  });

  it("4. Caller yang SUDAH punya membership DITOLAK, tanpa tenant kedua tercipta", async () => {
    const user = await createAuthUser("already-member");
    const scoped = await signInAs(user.email, user.password);

    const { data: first, error: firstErr } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT Pertama ${runTag}`,
      p_full_name: "Sudah Member",
    });
    expect(firstErr).toBeNull();
    const firstRow = (first as ProvisionResultRow[])[0];
    createdCompanyIds.push(firstRow.result_company_id);

    const { data: second, error: secondErr } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT Kedua ${runTag}`,
      p_full_name: "Sudah Member",
    });
    expect(second).toBeNull();
    expect(secondErr).not.toBeNull();
    expect(secondErr!.code).toBe("23505");
    expect(secondErr!.message).toContain("AODP_ALREADY_PROVISIONED");

    // Tidak ada tenant kedua -- hanya satu company untuk user ini.
    const { data: companies } = await service.from("companies").select("id").eq("name", `PT Kedua ${runTag}`);
    expect(companies ?? []).toHaveLength(0);
    const { data: roles } = await service.from("user_roles").select("id").eq("user_id", user.id);
    expect(roles).toHaveLength(1);
  });

  it("5. Caller tidak dapat memprovisi user lain -- RPC tidak menerima parameter user_id apa pun; hasil selalu untuk auth.uid() milik caller sendiri", async () => {
    const userA = await createAuthUser("self-only-a");
    const userB = await createAuthUser("self-only-b");
    const scopedA = await signInAs(userA.email, userA.password);

    // Coba selipkan parameter asing (mis. menyasar user lain) -- PostgREST
    // menolak seluruh panggilan karena signature fungsi tidak punya parameter
    // itu (function tidak ditemukan/parameter mismatch), BUKAN mengabaikannya
    // secara diam-diam.
    const { error: bogusErr } = await scopedA.rpc("provision_first_owner", {
      p_company_name: `PT Bogus ${runTag}`,
      p_full_name: "Selipan",
      target_user_id: userB.id,
    } as never);
    expect(bogusErr).not.toBeNull();

    // Panggilan sah tanpa parameter asing SELALU menghasilkan auth.uid() milik
    // caller sendiri (userA), tidak pernah userB.
    const { data, error } = await scopedA.rpc("provision_first_owner", {
      p_company_name: `PT SelfOnly ${runTag}`,
      p_full_name: "Self Only",
    });
    expect(error).toBeNull();
    const row = (data as ProvisionResultRow[])[0];
    createdCompanyIds.push(row.result_company_id);
    expect(row.result_user_id).toBe(userA.id);
    expect(row.result_user_id).not.toBe(userB.id);

    const { data: userBRoles } = await service.from("user_roles").select("id").eq("user_id", userB.id);
    expect(userBRoles ?? []).toHaveLength(0);
  });

  it("6. Spoofing user_metadata.role (super_admin/admin/sales) TIDAK memengaruhi hasil -- role yang di-assign SELALU owner", async () => {
    const user = await createAuthUser("spoof-role", { role: "super_admin", full_name: "Spoofer" });
    const scoped = await signInAs(user.email, user.password);

    const { data: userData } = await service.auth.admin.getUserById(user.id);
    expect((userData.user?.user_metadata as { role?: string } | null)?.role).toBe("super_admin");

    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT SpoofRole ${runTag}`,
      p_full_name: "Spoofer",
    });
    expect(error).toBeNull();
    const row = (data as ProvisionResultRow[])[0];
    createdCompanyIds.push(row.result_company_id);

    const { data: roles } = await service.from("user_roles").select("role_id").eq("user_id", user.id);
    expect(roles).toHaveLength(1);
    expect((roles![0] as { role_id: string }).role_id).toBe(ownerRoleId);

    const { data: superAdminRows } = await service
      .from("user_roles")
      .select("id, roles!inner(name)")
      .eq("user_id", user.id)
      .eq("roles.name", "super_admin");
    expect(superAdminRows ?? []).toHaveLength(0);
  });

  it("7. Metadata company_id tenant asing TIDAK memengaruhi hasil -- RPC selalu membuat company BARU, tidak pernah menyasar company_id existing", async () => {
    const foreignOwner = await createAuthUser("foreign-owner");
    const foreignScoped = await signInAs(foreignOwner.email, foreignOwner.password);
    const { data: foreignResult, error: foreignErr } = await foreignScoped.rpc("provision_first_owner", {
      p_company_name: `PT Asing ${runTag}`,
      p_full_name: "Foreign Owner",
    });
    expect(foreignErr).toBeNull();
    const foreignCompanyId = (foreignResult as ProvisionResultRow[])[0].result_company_id;
    createdCompanyIds.push(foreignCompanyId);

    const spoofedUser = await createAuthUser("spoof-company", { company_id: foreignCompanyId });
    const scoped = await signInAs(spoofedUser.email, spoofedUser.password);
    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT SpoofCompany ${runTag}`,
      p_full_name: "Spoof Company",
    });
    expect(error).toBeNull();
    const row = (data as ProvisionResultRow[])[0];
    createdCompanyIds.push(row.result_company_id);

    expect(row.result_company_id).not.toBe(foreignCompanyId);
    const { data: profile } = await service.from("users").select("company_id").eq("id", spoofedUser.id).single();
    expect((profile as { company_id: string }).company_id).toBe(row.result_company_id);
    expect((profile as { company_id: string }).company_id).not.toBe(foreignCompanyId);

    // Tenant asing tidak berubah -- masih tepat satu owner (foreignOwner).
    const { data: foreignRoles } = await service.from("user_roles").select("user_id").eq("company_id", foreignCompanyId);
    expect(foreignRoles).toHaveLength(1);
    expect((foreignRoles![0] as { user_id: string }).user_id).toBe(foreignOwner.id);
  });

  it("8. Role hasil akhir SELALU tepat 'owner', diresolve dari database (roles.name), bukan dari input/metadata apa pun", async () => {
    const user = await createAuthUser("role-from-db");
    const scoped = await signInAs(user.email, user.password);
    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT RoleDb ${runTag}`,
      p_full_name: "Role Db",
    });
    expect(error).toBeNull();
    const row = (data as ProvisionResultRow[])[0];
    createdCompanyIds.push(row.result_company_id);

    const { data: joined } = await service
      .from("user_roles")
      .select("roles!inner(name)")
      .eq("user_id", user.id)
      .single();
    expect((joined as { roles: { name: string } }).roles.name).toBe("owner");
  });

  it("9. Input invalid (company name kosong, full name kosong, phone terlalu panjang) GAGAL dengan zero partial rows", async () => {
    const user = await createAuthUser("invalid-input");
    const scoped = await signInAs(user.email, user.password);

    const { error: emptyCompanyErr } = await scoped.rpc("provision_first_owner", {
      p_company_name: "   ",
      p_full_name: "Valid Name",
    });
    expect(emptyCompanyErr).not.toBeNull();
    expect(emptyCompanyErr!.message).toContain("AODP_INVALID_INPUT");

    const { error: emptyNameErr } = await scoped.rpc("provision_first_owner", {
      p_company_name: "PT Valid Name",
      p_full_name: "  ",
    });
    expect(emptyNameErr).not.toBeNull();
    expect(emptyNameErr!.message).toContain("AODP_INVALID_INPUT");

    const { error: longPhoneErr } = await scoped.rpc("provision_first_owner", {
      p_company_name: "PT Valid Name",
      p_full_name: "Valid Owner",
      p_phone: "0".repeat(51),
    });
    expect(longPhoneErr).not.toBeNull();
    expect(longPhoneErr!.message).toContain("AODP_INVALID_INPUT");

    // Zero partial rows: caller belum punya profile/membership sama sekali.
    const { data: profile } = await service.from("users").select("id").eq("id", user.id);
    expect(profile ?? []).toHaveLength(0);
    const { data: roles } = await service.from("user_roles").select("id").eq("user_id", user.id);
    expect(roles ?? []).toHaveLength(0);
    const { data: companies } = await service.from("companies").select("id").eq("name", "PT Valid Name");
    expect(companies ?? []).toHaveLength(0);
  });

  it("10. Forced mid-transaction failure (profile row sudah ada duluan) membuktikan rollback PENUH -- companies row tidak tersisa", async () => {
    const user = await createAuthUser("forced-failure");
    // Simulasikan state anomali: profile SUDAH ada untuk id ini (tanpa
    // user_roles), sesuatu yang tidak seharusnya terjadi lewat jalur manapun
    // hari ini, tapi membuktikan INSERT INTO public.users di dalam RPC gagal
    // dengan unique_violation NATIVE Postgres SETELAH companies row (langkah
    // sebelumnya) sudah ter-insert di transaksi yang sama -- exception ini
    // harus merollback company row juga, tidak hanya gagal di step profile.
    const preExistingCompanyId = randomUUID();
    createdCompanyIds.push(preExistingCompanyId);
    await service.from("companies").insert({
      id: preExistingCompanyId,
      name: `PT PreExisting ${runTag}`,
      slug: `pre-existing-${runTag}`,
    });
    await service.from("users").insert({
      id: user.id,
      company_id: preExistingCompanyId,
      email: user.email,
      full_name: "Pre Existing Profile",
      is_active: true,
    });

    const scoped = await signInAs(user.email, user.password);
    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT ForcedFailure ${runTag}`,
      p_full_name: "Forced Failure",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");

    // Tidak ada company baru bernama "PT ForcedFailure ..." tersisa -- proof
    // rollback penuh, bukan partial (companies row dari RPC call ini hilang
    // meski sempat ter-insert sebelum profile insert gagal).
    const { data: leftoverCompanies } = await service.from("companies").select("id").eq("name", `PT ForcedFailure ${runTag}`);
    expect(leftoverCompanies ?? []).toHaveLength(0);

    // Profile pre-existing tetap utuh menunjuk company_id semula (tidak
    // ter-mutasi oleh percobaan RPC yang gagal).
    const { data: profile } = await service.from("users").select("company_id").eq("id", user.id).single();
    expect((profile as { company_id: string }).company_id).toBe(preExistingCompanyId);

    // Cleanup manual state anomali buatan test ini (bukan RPC).
    await service.from("users").delete().eq("id", user.id);
  });

  it("11. Dua panggilan concurrent untuk auth.uid() yang SAMA -- tepat SATU tenant/membership owner, tidak pernah dua-duanya", async () => {
    const user = await createAuthUser("race-same-user");
    const scoped = await signInAs(user.email, user.password);

    const [r1, r2] = await Promise.all([
      scoped.rpc("provision_first_owner", { p_company_name: `PT Race1 ${runTag}`, p_full_name: "Race User" }),
      scoped.rpc("provision_first_owner", { p_company_name: `PT Race2 ${runTag}`, p_full_name: "Race User" }),
    ]);

    const errors = [r1.error, r2.error];
    const successCount = errors.filter((e) => e === null).length;
    const failureCount = errors.filter((e) => e !== null).length;
    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);

    const failed = errors.find((e) => e !== null);
    expect(failed!.message).toContain("AODP_ALREADY_PROVISIONED");

    const successResult = (r1.error === null ? r1.data : r2.data) as ProvisionResultRow[];
    createdCompanyIds.push(successResult[0].result_company_id);

    const { data: roles } = await service.from("user_roles").select("id, company_id").eq("user_id", user.id);
    expect(roles).toHaveLength(1);

    const { data: companies } = await service.from("companies").select("id").in("name", [`PT Race1 ${runTag}`, `PT Race2 ${runTag}`]);
    expect(companies).toHaveLength(1);
  }, 30000);

  it("12. Direct RPC abuse via service-role client (tanpa sesi JWT user) DITOLAK di level privilege -- invariant tidak melemah", async () => {
    const { data, error } = await service.rpc("provision_first_owner", {
      p_company_name: `PT ServiceAbuse ${runTag}`,
      p_full_name: "Service Abuse",
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe("42501");
    expect(data).toBeNull();

    const { data: companies } = await service.from("companies").select("id").eq("name", `PT ServiceAbuse ${runTag}`);
    expect(companies ?? []).toHaveLength(0);
  });

  it("13. Gate 3D-B1 single-owner enforcement TETAP AKTIF terhadap company hasil RPC ini -- direct insert owner kedua ditolak trigger", async () => {
    const user = await createAuthUser("b1-regression-owner");
    const scoped = await signInAs(user.email, user.password);
    const { data, error } = await scoped.rpc("provision_first_owner", {
      p_company_name: `PT B1Regression ${runTag}`,
      p_full_name: "B1 Regression Owner",
    });
    expect(error).toBeNull();
    const companyId = (data as ProvisionResultRow[])[0].result_company_id;
    createdCompanyIds.push(companyId);

    const secondOwnerAuth = await createAuthUser("b1-regression-second");
    await service.from("users").insert({
      id: secondOwnerAuth.id,
      company_id: companyId,
      email: secondOwnerAuth.email,
      full_name: "Second Owner Attempt",
      is_active: true,
    });

    const { error: triggerErr } = await service
      .from("user_roles")
      .insert({ user_id: secondOwnerAuth.id, company_id: companyId, role_id: ownerRoleId });
    expect(triggerErr).not.toBeNull();
    expect(triggerErr!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");
    expect(triggerErr!.code).toBe("23505");

    await service.from("users").delete().eq("id", secondOwnerAuth.id);

    const { data: roles } = await service.from("user_roles").select("user_id").eq("company_id", companyId);
    expect(roles).toHaveLength(1);
    expect((roles![0] as { user_id: string }).user_id).toBe(user.id);
  });

  it("14. Tenant lain dan role existing (system roles) TIDAK berubah oleh panggilan RPC manapun di suite ini", async () => {
    const { data: systemRoles } = await service.from("roles").select("id, name").is("company_id", null);
    const names = (systemRoles ?? []).map((r) => (r as { name: string }).name).sort();
    expect(names).toEqual(["admin", "driver", "finance", "manager", "owner", "sales", "super_admin", "warehouse"]);

    const { data: ownerRoleCheck } = await service.from("roles").select("id").eq("name", "owner").is("company_id", null).single();
    expect((ownerRoleCheck as { id: string }).id).toBe(ownerRoleId);
  });
});
