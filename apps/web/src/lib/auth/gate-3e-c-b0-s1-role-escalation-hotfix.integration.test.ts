// =============================================================================
// Gate 3E-C-B0-S1 (Emergency Role Escalation Hotfix) -- DB-backed, Postgres/
// Supabase Auth NYATA (bukan mock). Membuktikan migration
// 20260909000001_gate_3e_c_b0_s1_role_escalation_hotfix.sql menutup temuan
// Gate 3E-C-B0: RLS "user_roles_manage" lama (FOR ALL, migration
// 20260626000004_rls_policies.sql:143-147) tidak pernah memeriksa role_id
// yang di-assign, sehingga owner (bahkan lewat REST langsung dengan sesi
// miliknya sendiri) bisa INSERT/UPDATE baris user_roles menuju role_id
// 'super_admin' untuk dirinya sendiri atau user lain di tenant yang sama.
//
// Semua percobaan INSERT/UPDATE "ditolak" di sini SENGAJA dilakukan lewat
// client TER-OTENTIKASI (anon key + signInWithPassword), BUKAN service-role
// -- ini persis jalur exploit yang ditemukan Gate 3E-C-B0 (direct REST call
// dengan JWT sesi caller sendiri). `service` (service-role) dipakai HANYA
// untuk setup/teardown fixture dan untuk membuktikan RPC first-owner
// provisioning + trigger single-owner tetap berjalan (keduanya bypass RLS
// sebagai pemilik tabel, tidak terpengaruh fix RLS ini sama sekali).
//
// Gate 3E-C-B0-S1-R1 (grup B & F di bawah): migration corrective
// 20260910000001 mengganti subquery EXISTS ambigu (yang ter-parse jadi
// tautologi self-reference u.company_id=u.company_id -- dibuktikan live via
// pg_policies pada Gate 3E-C-B0-S2) dengan pemanggilan fungsi SECURITY
// DEFINER public.is_same_tenant_member(). Grup F membuktikan fungsi itu
// BENAR-BENAR independen dari RLS users_company_select -- bukan cuma
// "kebetulan tetap benar" seperti subquery lama -- dengan memanggilnya
// langsung baik lewat sesi caller yang dibatasi RLS maupun lewat service-role
// yang sama sekali tidak dibatasi RLS pada public.users, dan membuktikan
// keduanya menghasilkan jawaban IDENTIK untuk pasangan (user, company) yang
// sama.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola
// identik dengan gate-3b-role-permission-matrix.integration.test.ts dan
// gate-3d-b1-single-owner-enforcement.integration.test.ts.
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

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-C-B0-S1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-C-B0-S1: block tenant role escalation to system roles (RLS user_roles_insert/update, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ecb0s1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  const ACCOUNTS: ReadonlyArray<{ key: string; role: "owner" | "admin" | "sales"; company: "own" | "other" }> = [
    { key: "owner", role: "owner", company: "own" },
    { key: "admin", role: "admin", company: "own" },
    { key: "sales", role: "sales", company: "own" },
    { key: "otherOwner", role: "owner", company: "other" },
  ];

  const authIds: Record<string, string> = {};
  let superAdminRoleId = "";
  let ownerRoleId = "";
  let adminRoleId = "";
  let salesRoleId = "";
  let foreignUserId = "";

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign-in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert([
      { id: companyId, name: `Gate 3E-C-B0-S1 ${runTag}`, slug: `gate-3ecb0s1-${runTag}`, legal_address: "Jl. Gate 3E-C-B0-S1 No. 1", contact_email: "gate3ecb0s1@demo.test", contact_phone: "021-5570000", document_number_prefix: "G3ECB0S1" },
      { id: otherCompanyId, name: `Gate 3E-C-B0-S1 Other ${runTag}`, slug: `gate-3ecb0s1-other-${runTag}`, legal_address: "Jl. Gate 3E-C-B0-S1 No. 2", contact_email: "gate3ecb0s1-other@demo.test", contact_phone: "021-5570001", document_number_prefix: "G3ECB0S1O" },
    ]);

    const [{ data: superAdminRole }, { data: ownerRole }, { data: adminRole }, { data: salesRole }] = await Promise.all([
      service.from("roles").select("id").eq("name", "super_admin").is("company_id", null).single(),
      service.from("roles").select("id").eq("name", "owner").is("company_id", null).single(),
      service.from("roles").select("id").eq("name", "admin").is("company_id", null).single(),
      service.from("roles").select("id").eq("name", "sales").is("company_id", null).single(),
    ]);
    superAdminRoleId = (superAdminRole as { id: string }).id;
    ownerRoleId = (ownerRole as { id: string }).id;
    adminRoleId = (adminRole as { id: string }).id;
    salesRoleId = (salesRole as { id: string }).id;

    for (const acc of ACCOUNTS) {
      const email = `${runTag}-${acc.key}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: `Itest ${acc.key}` },
      });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${acc.key}: ${authErr?.message}`);
      authIds[acc.key] = auth.user.id;

      const targetCompany = acc.company === "other" ? otherCompanyId : companyId;
      await service.from("users").insert({ id: auth.user.id, company_id: targetCompany, email, full_name: `Itest ${acc.key}`, is_active: true });

      const roleId = acc.role === "owner" ? ownerRoleId : acc.role === "admin" ? adminRoleId : salesRoleId;
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: targetCompany, role_id: roleId });
    }

    // User "asing" -- profil miliknya ada di otherCompanyId, dipakai untuk
    // membuktikan konsistensi target membership (users.company_id harus
    // sama dengan user_roles.company_id yang di-assign).
    const foreignEmail = `${runTag}-foreign@itest.test`;
    const { data: foreignAuth, error: foreignErr } = await service.auth.admin.createUser({
      email: foreignEmail, password, email_confirm: true,
    });
    if (foreignErr || !foreignAuth.user) throw new Error(`gagal buat auth user foreign: ${foreignErr?.message}`);
    foreignUserId = foreignAuth.user.id;
    await service.from("users").insert({ id: foreignUserId, company_id: otherCompanyId, email: foreignEmail, full_name: "Itest Foreign", is_active: true });
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    const allIds = [...Object.values(authIds), foreignUserId].filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyId, otherCompanyId]);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  describe("A. Owner mencoba self-escalate / escalate user lain ke super_admin lewat direct INSERT -- DITOLAK", () => {
    it("1. Owner DITOLAK insert super_admin untuk DIRINYA SENDIRI", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: authIds.owner, company_id: companyId, role_id: superAdminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);

      const { data: rows } = await service.from("user_roles").select("id").eq("user_id", authIds.owner).eq("role_id", superAdminRoleId);
      expect(rows ?? []).toHaveLength(0);
    });

    it("2. Owner DITOLAK insert super_admin untuk USER LAIN di tenant yang sama (mis. sales)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: authIds.sales, company_id: companyId, role_id: superAdminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);

      const { data: rows } = await service.from("user_roles").select("id").eq("user_id", authIds.sales).eq("role_id", superAdminRoleId);
      expect(rows ?? []).toHaveLength(0);
    });

    it("3. Owner DITOLAK UPDATE membership existing (admin) menjadi super_admin", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data: existing } = await service.from("user_roles").select("id").eq("user_id", authIds.admin).eq("company_id", companyId).single();
      const rowId = (existing as { id: string }).id;

      const { data, error } = await scoped.from("user_roles").update({ role_id: superAdminRoleId }).eq("id", rowId).select("id");
      // WITH CHECK gagal -> PostgREST melempar error eksplisit "new row violates
      // row-level security policy" (bukan silently 0-row) karena baris LAMA lolos
      // USING (owner boleh lihat/target baris admin miliknya), tapi baris BARU
      // (role_id=super_admin) gagal WITH CHECK.
      expect(error).not.toBeNull();
      expect(error!.code).toBe("42501");
      expect(data ?? []).toHaveLength(0);

      const { data: unchanged } = await service.from("user_roles").select("role_id").eq("id", rowId).single();
      expect((unchanged as { role_id: string }).role_id).toBe(adminRoleId);
    });

    it("4. Mengetahui UUID super_admin yang valid TIDAK membuka bypass apa pun (role_id benar, tetap ditolak allowlist)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data: superAdminRow, error: readErr } = await scoped.from("roles").select("id, name").eq("id", superAdminRoleId).single();
      // roles_select tetap mengizinkan baca (company_id IS NULL) -- ini bukan regresi,
      // membaca UUID role bukan celah; celahnya ada di penulisan user_roles.
      expect(readErr).toBeNull();
      expect((superAdminRow as { name: string }).name).toBe("super_admin");

      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: authIds.owner, company_id: companyId, role_id: (superAdminRow as { id: string }).id })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });
  });

  describe("B. Manipulasi role_id/user_id/company_id lain -- semua DITOLAK", () => {
    it("5. Cross-tenant: owner tenant lain DITOLAK insert user_roles ke company_id tenant ini", async () => {
      const scoped = await signIn(`${runTag}-otherOwner@itest.test`);
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: authIds.otherOwner, company_id: companyId, role_id: adminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("6. company_id spoof: owner DITOLAK insert baris company_id=tenant lain meski role_id valid admin/sales", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: authIds.owner, company_id: otherCompanyId, role_id: adminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("7. Target membership tidak konsisten: owner DITOLAK insert user_roles company_id=tenant sendiri untuk user_id yang users.company_id-nya tenant LAIN (Gate 3E-C-B0-S1-R1: ditolak oleh is_same_tenant_member, BUKAN kebetulan lewat RLS users_company_select -- lihat grup F)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: foreignUserId, company_id: companyId, role_id: adminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("7b. UPDATE user_id baris existing ke user tenant LAIN (mismatched target) DITOLAK -- tetap company_id tenant sendiri", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      // Baris awal valid: user milik companyId sendiri, role sales.
      const email = `${runTag}-mismatchTargetBase@itest.test`;
      const { data: baseAuth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const baseUserId = (baseAuth as { user: { id: string } }).user.id;
      await service.from("users").insert({ id: baseUserId, company_id: companyId, email, full_name: "Itest Mismatch Base", is_active: true });
      const { data: inserted, error: insertErr } = await scoped
        .from("user_roles")
        .insert({ user_id: baseUserId, company_id: companyId, role_id: salesRoleId })
        .select("id")
        .single();
      expect(insertErr).toBeNull();
      const rowId = (inserted as { id: string }).id;

      // Coba alihkan baris yang SAMA ke foreignUserId (anggota otherCompanyId)
      // sambil company_id tetap companyId -- fabrikasi membership lintas-tenant
      // lewat UPDATE, bukan INSERT.
      const { data } = await scoped.from("user_roles").update({ user_id: foreignUserId }).eq("id", rowId).select("id");
      expect(data ?? []).toHaveLength(0);

      const { data: unchanged } = await service.from("user_roles").select("user_id").eq("id", rowId).single();
      expect((unchanged as { user_id: string }).user_id).toBe(baseUserId);

      await service.from("user_roles").delete().eq("id", rowId);
      await service.from("users").delete().eq("id", baseUserId);
      await service.auth.admin.deleteUser(baseUserId);
    });

    it("7c. Insert dengan user_id yang TIDAK ADA di public.users sama sekali DITOLAK", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const nonexistentUserId = randomUUID();
      const { data, error } = await scoped
        .from("user_roles")
        .insert({ user_id: nonexistentUserId, company_id: companyId, role_id: adminRoleId })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("8. Owner DITOLAK UPDATE company_id baris existing memindahkan membership ke tenant lain", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data: existing } = await service.from("user_roles").select("id").eq("user_id", authIds.sales).eq("company_id", companyId).single();
      const rowId = (existing as { id: string }).id;

      const { data } = await scoped.from("user_roles").update({ company_id: otherCompanyId }).eq("id", rowId).select("id");
      expect(data ?? []).toHaveLength(0);

      const { data: unchanged } = await service.from("user_roles").select("company_id").eq("id", rowId).single();
      expect((unchanged as { company_id: string }).company_id).toBe(companyId);
    });
  });

  describe("C. Admin dan sales tidak dapat menetapkan role sama sekali", () => {
    it("9. Admin DITOLAK insert role apa pun (termasuk sales) untuk user lain -- admin bukan actor ber-privilege user_roles_manage", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const email = `${runTag}-admin-victim@itest.test`;
      const { data: victimAuth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const victimId = (victimAuth as { user: { id: string } }).user.id;
      await service.from("users").insert({ id: victimId, company_id: companyId, email, full_name: "Itest Admin Victim", is_active: true });

      const { data, error } = await scoped.from("user_roles").insert({ user_id: victimId, company_id: companyId, role_id: salesRoleId }).select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);

      await service.from("users").delete().eq("id", victimId);
      await service.auth.admin.deleteUser(victimId);
    });

    it("10. Sales DITOLAK insert role apa pun untuk dirinya sendiri atau user lain", async () => {
      const scoped = await signIn(`${runTag}-sales@itest.test`);
      const { data, error } = await scoped.from("user_roles").insert({ user_id: authIds.sales, company_id: companyId, role_id: adminRoleId }).select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });
  });

  describe("D. Assignment owner kedua TETAP ditolak (trigger Gate 3D-B1 tidak diregresi oleh fix RLS ini)", () => {
    it("11. Owner DITOLAK insert role_id owner untuk user lain di tenant yang SUDAH punya owner (ditolak RLS allowlist SEBELUM sempat kena trigger)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped.from("user_roles").insert({ user_id: authIds.sales, company_id: companyId, role_id: ownerRoleId }).select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("12. Service-role (jalur RPC/bypass RLS) mencoba insert owner kedua TETAP ditolak trigger Gate 3D-B1 (tidak diregresi)", async () => {
      const email = `${runTag}-serviceSecondOwner@itest.test`;
      const { data: auth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const userId = (auth as { user: { id: string } }).user.id;
      await service.from("users").insert({ id: userId, company_id: companyId, email, full_name: "Itest Second Owner", is_active: true });

      const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyId, role_id: ownerRoleId });
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");

      await service.from("users").delete().eq("id", userId);
      await service.auth.admin.deleteUser(userId);
    });
  });

  describe("E. Jalur legit tetap berjalan -- tidak diregresi oleh fix ini", () => {
    it("13. Owner BERHASIL insert role admin untuk user baru di tenant sendiri (allowlist mengizinkan)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const email = `${runTag}-newAdmin@itest.test`;
      const { data: newAuth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const newUserId = (newAuth as { user: { id: string } }).user.id;
      await service.from("users").insert({ id: newUserId, company_id: companyId, email, full_name: "Itest New Admin", is_active: true });

      const { data, error } = await scoped.from("user_roles").insert({ user_id: newUserId, company_id: companyId, role_id: adminRoleId }).select("id");
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
    });

    it("14. Owner BERHASIL insert role sales untuk user baru di tenant sendiri (allowlist mengizinkan)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const email = `${runTag}-newSales@itest.test`;
      const { data: newAuth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const newUserId = (newAuth as { user: { id: string } }).user.id;
      await service.from("users").insert({ id: newUserId, company_id: companyId, email, full_name: "Itest New Sales", is_active: true });

      const { data, error } = await scoped.from("user_roles").insert({ user_id: newUserId, company_id: companyId, role_id: salesRoleId }).select("id");
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
    });

    it("15. Provisioning first-owner (RPC SECURITY DEFINER) TETAP BERHASIL -- tidak terhalang fix RLS user_roles (RPC bypass RLS sebagai pemilik tabel)", async () => {
      const email = `${runTag}-rpcFirstOwner@itest.test`;
      const { data: newAuth } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      const newUserId = (newAuth as { user: { id: string } }).user.id;

      const scoped = await signIn(email);
      const { data, error } = await scoped.rpc("provision_first_owner", {
        p_company_name: `RPC First Owner ${runTag}`,
        p_full_name: "Itest RPC First Owner",
        p_phone: "021-5570099",
      });
      expect(error).toBeNull();
      expect(Array.isArray(data) ? data.length : 0 >= 0).toBeTruthy();

      const { data: roleRow } = await service.from("user_roles").select("role:roles(name), company_id").eq("user_id", newUserId).single();
      const provisioned = roleRow as { role: { name: string } | null; company_id: string } | null;
      expect(provisioned?.role?.name).toBe("owner");

      // Cleanup fixture ekstra di luar allCompanyIds afterAll (company baru dari RPC).
      if (provisioned?.company_id) {
        await service.from("user_roles").delete().eq("company_id", provisioned.company_id);
        await service.from("companies").delete().eq("id", provisioned.company_id);
      }
      await service.from("users").delete().eq("id", newUserId);
      await service.auth.admin.deleteUser(newUserId);
    });
  });

  describe("F. is_same_tenant_member() independen dari RLS public.users (Gate 3E-C-B0-S1-R1)", () => {
    // Bukti "tidak tautologis / tidak bergantung pada users_company_select":
    // panggil fungsi yang SAMA PERSIS dipakai policy (bukan mock/reimplementasi
    // terpisah) lewat DUA konteks caller yang RLS-nya sangat berbeda --
    // service-role (ZERO restriksi RLS pada public.users -- melihat SEMUA
    // baris tanpa filter apa pun) dan sesi owner ter-otentikasi (dibatasi
    // users_company_select -- tidak bisa SELECT baris foreignUserId sama
    // sekali). Bila fungsi ini diam-diam masih bergantung pada RLS caller
    // untuk jawabannya (persis bug lama), kedua konteks akan menghasilkan
    // jawaban BERBEDA untuk pasangan yang sama. Hasil harus IDENTIK.
    it("16. Pasangan (foreignUserId, companyId) MISMATCH -- FALSE baik dipanggil service-role (tanpa RLS sama sekali) maupun sesi owner (dibatasi RLS)", async () => {
      const { data: viaService, error: serviceErr } = await service.rpc("is_same_tenant_member", {
        p_user_id: foreignUserId,
        p_company_id: companyId,
      });
      expect(serviceErr).toBeNull();
      expect(viaService).toBe(false);

      const scoped = await signIn(`${runTag}-owner@itest.test`);
      // Kontrol: owner memang TIDAK BISA melihat baris foreignUserId sama
      // sekali (RLS users_company_select) -- membuktikan konteks ini genuinely
      // lebih restriktif daripada service-role, bukan cuma formalitas.
      const { data: visibleToOwner } = await scoped.from("users").select("id").eq("id", foreignUserId);
      expect(visibleToOwner ?? []).toHaveLength(0);

      const { data: viaOwnerSession, error: ownerErr } = await scoped.rpc("is_same_tenant_member", {
        p_user_id: foreignUserId,
        p_company_id: companyId,
      });
      expect(ownerErr).toBeNull();
      expect(viaOwnerSession).toBe(false);
    });

    it("17. Pasangan (authIds.sales, companyId) MATCH -- TRUE baik dipanggil service-role maupun sesi owner", async () => {
      const { data: viaService, error: serviceErr } = await service.rpc("is_same_tenant_member", {
        p_user_id: authIds.sales,
        p_company_id: companyId,
      });
      expect(serviceErr).toBeNull();
      expect(viaService).toBe(true);

      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data: viaOwnerSession, error: ownerErr } = await scoped.rpc("is_same_tenant_member", {
        p_user_id: authIds.sales,
        p_company_id: companyId,
      });
      expect(ownerErr).toBeNull();
      expect(viaOwnerSession).toBe(true);
    });

    it("18. user_id valid tapi company_id SALAH (bukan tenant user tersebut) -- FALSE, bukan sekadar 'user ada'", async () => {
      // authIds.sales benar-benar ada di companyId, BUKAN otherCompanyId --
      // membuktikan perbandingan company_id-nya eksak, bukan hanya EXISTS(id).
      const { data } = await service.rpc("is_same_tenant_member", {
        p_user_id: authIds.sales,
        p_company_id: otherCompanyId,
      });
      expect(data).toBe(false);
    });
  });
});
