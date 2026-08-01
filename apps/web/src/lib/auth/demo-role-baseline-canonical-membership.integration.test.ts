// =============================================================================
// Gate 3A (Demo Authentication Foundation) -- membuktikan lewat Supabase Auth
// SUNGGUHAN (bukan mock) bahwa untuk ketiga role baseline (owner/admin/sales):
//   1. Login sukses membaca role dari user_roles -> roles (canonical
//      membership) -- query yang PERSIS ditiru dari getAuthUser()
//      (apps/web/src/lib/auth/get-user.ts) -- BUKAN dari user_metadata, yang
//      di sini sengaja diisi nilai role yang SALAH untuk membuktikan nilai
//      itu tidak pernah dipakai/dipercaya.
//   2. Password salah ditolak Supabase Auth.
//   3. Ketiga akun berada dalam tenant (company_id) yang SAMA.
//   4. User tanpa profile di public.users (belum ada membership) gagal
//      secara eksplisit -- getAuthUser() redirect ke /login ketika
//      `profile` null; di sini dibuktikan pada level query yang sama.
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

/** Meniru PERSIS resolusi role di getAuthUser() -- user_roles -> roles, tanpa menyentuh user_metadata. */
async function readRoleNamesFromDb(client: SupabaseClient, userId: string, companyId: string): Promise<string[]> {
  const { data: userRolesData } = await client.from("user_roles").select("role_id").eq("user_id", userId).eq("company_id", companyId);
  const roleIds = ((userRolesData ?? []) as { role_id: string }[]).map((r) => r.role_id);
  if (roleIds.length === 0) return [];
  const { data: rolesData } = await client.from("roles").select("name").in("id", roleIds);
  return ((rolesData ?? []) as { name: string }[]).map((r) => r.name);
}

describeIfDb("Gate 3A: role baseline owner/admin/sales dibaca dari canonical membership (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-role-baseline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const password = randomUUID();

  const ACCOUNTS = [
    { role: "owner", spoofedMetadataRole: "sales" },
    { role: "admin", spoofedMetadataRole: "owner" },
    { role: "sales", spoofedMetadataRole: "admin" },
  ] as const;

  const authIds: Record<string, string> = {};
  let noMembershipAuthId = "";

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert({
      id: companyId,
      name: `Role Baseline ${runTag}`,
      slug: `role-baseline-${runTag}`,
      legal_address: "Jl. Role Baseline No. 1",
      contact_email: "role-baseline@demo.test",
      contact_phone: "021-5559999",
      document_number_prefix: "RBL",
    });

    for (const acc of ACCOUNTS) {
      const email = `${runTag}-${acc.role}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        // Metadata SENGAJA diisi role yang SALAH -- membuktikan nilai ini
        // tidak pernah dipakai untuk resolusi role (lihat assertion di bawah).
        user_metadata: { role: acc.spoofedMetadataRole, full_name: `Itest ${acc.role}` },
      });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${acc.role}: ${authErr?.message}`);
      authIds[acc.role] = auth.user.id;

      await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${acc.role}`, is_active: true });

      const { data: roleRow, error: roleErr } = await service.from("roles").select("id").eq("name", acc.role).is("company_id", null).single();
      if (roleErr || !roleRow) throw new Error(`role '${acc.role}' tidak ditemukan di seed sistem`);
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    }

    // Auth user TANPA profile di public.users -- simulasi "user tanpa membership aktif".
    const noMembershipEmail = `${runTag}-no-membership@itest.test`;
    const { data: noMembershipAuth, error: noMembershipErr } = await service.auth.admin.createUser({
      email: noMembershipEmail,
      password,
      email_confirm: true,
    });
    if (noMembershipErr || !noMembershipAuth.user) throw new Error(`gagal buat auth user no-membership: ${noMembershipErr?.message}`);
    noMembershipAuthId = noMembershipAuth.user.id;
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    for (const acc of ACCOUNTS) {
      const id = authIds[acc.role];
      if (!id) continue;
      await service.from("user_roles").delete().eq("user_id", id);
      await service.from("users").delete().eq("id", id);
      await service.auth.admin.deleteUser(id);
    }
    if (noMembershipAuthId) await service.auth.admin.deleteUser(noMembershipAuthId);
    await service.from("companies").delete().eq("id", companyId);
  }, 30000);

  it("1. Password salah DITOLAK Supabase Auth", async () => {
    const anon = createServiceClient(env!.url, env!.anonKey);
    const { error } = await anon.auth.signInWithPassword({ email: `${runTag}-owner@itest.test`, password: "password-salah-sengaja-000" });
    expect(error).not.toBeNull();
  });

  for (const acc of ACCOUNTS) {
    it(`2. ${acc.role} login berhasil dan terbaca sebagai role '${acc.role}' dari user_roles/roles -- BUKAN dari user_metadata (yang diisi '${acc.spoofedMetadataRole}')`, async () => {
      const scoped = createServiceClient(env!.url, env!.anonKey);
      const email = `${runTag}-${acc.role}@itest.test`;
      const { data: signInData, error: signInErr } = await scoped.auth.signInWithPassword({ email, password });
      expect(signInErr).toBeNull();
      expect(signInData.session).not.toBeNull();

      const { data: userData } = await scoped.auth.getUser();
      // Metadata memang berisi role yang salah -- dibuktikan di sini SEBELUM
      // membuktikan bahwa resolusi role sesungguhnya (di bawah) mengabaikannya.
      expect((userData.user!.user_metadata as { role?: string } | null)?.role).toBe(acc.spoofedMetadataRole);

      const roles = await readRoleNamesFromDb(scoped, userData.user!.id, companyId);
      expect(roles).toEqual([acc.role]);
    });
  }

  it("3. Owner/Admin/Sales berada dalam tenant (company_id) yang SAMA", async () => {
    for (const acc of ACCOUNTS) {
      const { data } = await service.from("users").select("company_id").eq("id", authIds[acc.role]).single();
      expect((data as { company_id: string }).company_id).toBe(companyId);
    }
  });

  it("4. User tanpa membership (tidak ada baris public.users) gagal-closed -- profile null persis kondisi redirect di getAuthUser()", async () => {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const noMembershipEmail = `${runTag}-no-membership@itest.test`;
    const { error: signInErr } = await scoped.auth.signInWithPassword({ email: noMembershipEmail, password });
    expect(signInErr).toBeNull();

    const { data: userData } = await scoped.auth.getUser();
    const { data: profile } = await scoped.from("users").select("id, company_id, is_active").eq("id", userData.user!.id).maybeSingle();
    expect(profile).toBeNull();
  });
});
