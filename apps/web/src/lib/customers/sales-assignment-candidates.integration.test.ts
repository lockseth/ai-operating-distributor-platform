// =============================================================================
// DB-backed integration test -- kandidat Sales pada dropdown "Sales yang
// Menangani" di halaman edit pelanggan (Gate 3E-D5-B-H-R1).
//
// Regresi utama gate ini: query lama merujuk users.roles (kolom yang TIDAK
// ADA di schema), sehingga dropdown selalu kosong. Fix memakai pola yang
// SAMA dengan kpi/setup/page.tsx: SELECT dari user_roles, embed
// users!user_id + roles!role_id, filter role.name==='sales' &&
// user.is_active===true di JS. Test ini menjalankan query yang PERSIS SAMA
// (RLS-scoped, bukan service-role) lewat sesi actor sungguhan supaya
// membuktikan perilaku production, bukan sekadar keberadaan baris.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback -- pola identik dengan
// cross-tenant-and-rls.integration.test.ts di direktori yang sama.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
    : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("DB integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

interface RoleRow {
  user: { id: string; full_name: string; is_active: boolean } | null;
  role: { name: string } | null;
}

/** Transform yang persis sama dengan customers/[id]/edit/page.tsx setelah fix. */
function toSalesCandidates(rows: RoleRow[]): { id: string; full_name: string }[] {
  return rows
    .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
    .map((r) => ({ id: r.user!.id, full_name: r.user!.full_name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

describeIfDb("Gate 3E-D5-B-H-R1 -- kandidat Sales dropdown edit pelanggan (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-salescand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyAId = randomUUID(); // tenant dengan Sales aktif+nonaktif, Owner, Admin.
  const companyBId = randomUUID(); // tenant lain dengan Sales sendiri -- untuk uji isolasi tenant.
  const companyCId = randomUUID(); // tenant tanpa Sales sama sekali -- untuk uji empty state.
  let ownerAAuthId = "";
  let salesA1AuthId = "";
  let salesA2InactiveAuthId = "";
  let adminAAuthId = "";
  let salesBAuthId = "";
  let ownerCAuthId = "";
  const password = randomUUID();

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  /** Query yang PERSIS SAMA dengan customers/[id]/edit/page.tsx setelah fix. */
  async function fetchSalesCandidates(client: SupabaseClient, companyId: string) {
    const { data, error } = await client
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", companyId);
    if (error) throw error;
    return toSalesCandidates((data ?? []) as unknown as RoleRow[]);
  }

  beforeAll(async () => {
    service = createClient(env!.url, env!.serviceRoleKey);

    const { data: roles } = await service.from("roles").select("id, name").in("name", ["owner", "admin", "sales"]);
    const roleId = (name: string) => (roles as { id: string; name: string }[]).find((r) => r.name === name)!.id;

    const emails = {
      ownerA: `${runTag}-owner-a@verify.test`,
      salesA1: `${runTag}-sales-a1@verify.test`,
      salesA2: `${runTag}-sales-a2-inactive@verify.test`,
      adminA: `${runTag}-admin-a@verify.test`,
      salesB: `${runTag}-sales-b@verify.test`,
      ownerC: `${runTag}-owner-c-no-sales@verify.test`,
    };

    const mkUser = async (email: string) => {
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`gagal buat auth user ${email}: ${error?.message}`);
      return data.user.id;
    };

    ownerAAuthId = await mkUser(emails.ownerA);
    salesA1AuthId = await mkUser(emails.salesA1);
    salesA2InactiveAuthId = await mkUser(emails.salesA2);
    adminAAuthId = await mkUser(emails.adminA);
    salesBAuthId = await mkUser(emails.salesB);
    ownerCAuthId = await mkUser(emails.ownerC);

    await service.from("companies").insert([
      { id: companyAId, name: `Verify SalesCand Co A ${runTag}`, slug: `verify-salescand-a-${runTag}` },
      { id: companyBId, name: `Verify SalesCand Co B ${runTag}`, slug: `verify-salescand-b-${runTag}` },
      { id: companyCId, name: `Verify SalesCand Co C ${runTag}`, slug: `verify-salescand-c-${runTag}` },
    ]);
    await service.from("users").insert([
      { id: ownerAAuthId, company_id: companyAId, email: emails.ownerA, full_name: "Owner A", is_active: true },
      { id: salesA1AuthId, company_id: companyAId, email: emails.salesA1, full_name: "Sales Aktif A", is_active: true },
      { id: salesA2InactiveAuthId, company_id: companyAId, email: emails.salesA2, full_name: "Sales Nonaktif A", is_active: false },
      { id: adminAAuthId, company_id: companyAId, email: emails.adminA, full_name: "Admin A", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: emails.salesB, full_name: "Sales Tenant B", is_active: true },
      { id: ownerCAuthId, company_id: companyCId, email: emails.ownerC, full_name: "Owner Tenant C (no sales)", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAAuthId, company_id: companyAId, role_id: roleId("owner") },
      { user_id: salesA1AuthId, company_id: companyAId, role_id: roleId("sales") },
      { user_id: salesA2InactiveAuthId, company_id: companyAId, role_id: roleId("sales") },
      { user_id: adminAAuthId, company_id: companyAId, role_id: roleId("admin") },
      { user_id: salesBAuthId, company_id: companyBId, role_id: roleId("sales") },
      { user_id: ownerCAuthId, company_id: companyCId, role_id: roleId("owner") },
    ]);
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("user_roles").delete().in("company_id", [companyAId, companyBId, companyCId]);
    await service.from("users").delete().in("id", [
      ownerAAuthId, salesA1AuthId, salesA2InactiveAuthId, adminAAuthId, salesBAuthId, ownerCAuthId,
    ]);
    await service.from("companies").delete().in("id", [companyAId, companyBId, companyCId]);
    for (const id of [ownerAAuthId, salesA1AuthId, salesA2InactiveAuthId, adminAAuthId, salesBAuthId, ownerCAuthId]) {
      if (id) await service.auth.admin.deleteUser(id);
    }
  }, 30000);

  it("1. Sales aktif dari tenant yang sama tampil sebagai kandidat", async () => {
    const asOwnerA = await signIn(`${runTag}-owner-a@verify.test`);
    const candidates = await fetchSalesCandidates(asOwnerA, companyAId);
    expect(candidates.map((c) => c.id)).toContain(salesA1AuthId);
  });

  it("2. Owner, Admin, dan Sales nonaktif TIDAK tampil sebagai kandidat", async () => {
    const asOwnerA = await signIn(`${runTag}-owner-a@verify.test`);
    const candidates = await fetchSalesCandidates(asOwnerA, companyAId);
    const ids = candidates.map((c) => c.id);
    expect(ids).not.toContain(ownerAAuthId);
    expect(ids).not.toContain(adminAAuthId);
    expect(ids).not.toContain(salesA2InactiveAuthId); // role sales tapi is_active=false.
  });

  it("3. Sales dari tenant lain TIDAK tampil sebagai kandidat (tenant isolation)", async () => {
    const asOwnerA = await signIn(`${runTag}-owner-a@verify.test`);
    const candidates = await fetchSalesCandidates(asOwnerA, companyAId);
    expect(candidates.map((c) => c.id)).not.toContain(salesBAuthId);
  });

  it("4. Empty state benar bila tenant memang tidak punya Sales sah sama sekali", async () => {
    const asOwnerC = await signIn(`${runTag}-owner-c-no-sales@verify.test`);
    const candidates = await fetchSalesCandidates(asOwnerC, companyCId);
    expect(candidates).toEqual([]);
  });

  it("5. Admin (customers.update) di tenant sendiri tetap bisa membaca kandidat yang sama (tidak butuh service-role)", async () => {
    const asAdminA = await signIn(`${runTag}-admin-a@verify.test`);
    const candidates = await fetchSalesCandidates(asAdminA, companyAId);
    expect(candidates.map((c) => c.id)).toContain(salesA1AuthId);
  });
});
