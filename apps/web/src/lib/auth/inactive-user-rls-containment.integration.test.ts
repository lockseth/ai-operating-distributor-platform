// =============================================================================
// Gate 3A finding (Auth/RBAC/RLS -- user nonaktif, migration
// 20260904000001_inactive_user_rls_containment.sql): get_user_company_id()
// (dan lewat itu, user_has_permission()/user_has_role() yang memanggilnya)
// sebelumnya TIDAK PERNAH memeriksa users.is_active -- user yang
// dinonaktifkan tapi sesi Supabase Auth-nya masih valid TETAP lolos RLS
// policy generik apa pun yang bergantung pada ketiga fungsi ini.
//
// Test ini membuktikan lewat sesi PostgREST/Supabase Auth SUNGGUHAN (bukan
// RPC actor-check, bukan filter aplikasi) -- sign in sungguhan sebagai user
// role owner, buktikan RLS SELECT customers company sendiri berhasil
// (baseline, sebelum dinonaktifkan), lalu nonaktifkan user itu (service_role,
// simulasi Owner menonaktifkan karyawan), lalu SESI YANG SAMA (token belum
// dicabut) mengulang query yang SAMA -- harus kembali KOSONG, membuktikan
// RLS sungguhan menolak, bukan hanya UI/RPC-level check.
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

describeIfDb("Gate 3A: get_user_company_id() menolak user nonaktif di level RLS (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-inactive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let ownerAuthId = "";
  const ownerPassword = randomUUID();
  const ownerEmail = `${runTag}-owner@itest.test`;
  let customerId = "";

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert({
      id: companyId,
      name: `Inactive User RLS ${runTag}`,
      slug: `inactive-rls-${runTag}`,
      legal_address: "Jl. Inactive RLS No. 1",
      contact_email: "inactive-rls@demo.test",
      contact_phone: "021-5551234",
      document_number_prefix: "IRL",
    });

    const { data: auth, error: authErr } = await service.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true });
    if (authErr || !auth.user) throw new Error(`gagal buat auth user: ${authErr?.message}`);
    ownerAuthId = auth.user.id;
    await service.from("users").insert({ id: ownerAuthId, company_id: companyId, email: ownerEmail, full_name: "Owner Inactive RLS Test", is_active: true });

    const { data: ownerRole } = await service.from("roles").select("id").eq("name", "owner").single();
    await service.from("user_roles").insert({ user_id: ownerAuthId, company_id: companyId, role_id: (ownerRole as { id: string }).id });

    const { data: customer, error: custErr } = await service
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}`, code: `CUST-${runTag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    customerId = (customer as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("customers").delete().eq("company_id", companyId);
    await service.from("user_roles").delete().eq("user_id", ownerAuthId);
    await service.from("users").delete().eq("id", ownerAuthId);
    if (ownerAuthId) await service.auth.admin.deleteUser(ownerAuthId);
    await service.from("companies").delete().eq("id", companyId);
  }, 30000);

  it("1. Selagi aktif: sign-in sungguhan sebagai owner bisa SELECT customer company sendiri lewat RLS", async () => {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error: signInErr } = await scoped.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword });
    if (signInErr) throw new Error(`gagal sign-in owner ITest: ${signInErr.message}`);

    const { data, error } = await scoped.from("customers").select("id").eq("id", customerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("2. Setelah dinonaktifkan (service_role UPDATE is_active=false): SESI YANG SAMA kehilangan akses RLS ke customer yang SAMA (bukan lagi 1 baris, jadi 0)", async () => {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error: signInErr } = await scoped.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword });
    if (signInErr) throw new Error(`gagal sign-in owner ITest: ${signInErr.message}`);

    const preCheck = await scoped.from("customers").select("id").eq("id", customerId);
    expect(preCheck.data).toHaveLength(1);

    const { error: deactivateErr } = await service.from("users").update({ is_active: false }).eq("id", ownerAuthId);
    if (deactivateErr) throw new Error(`gagal nonaktifkan user: ${deactivateErr.message}`);

    const { data, error } = await scoped.from("customers").select("id").eq("id", customerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
