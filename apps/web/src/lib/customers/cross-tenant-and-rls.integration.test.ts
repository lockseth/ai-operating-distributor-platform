// =============================================================================
// DB-backed integration test -- products/customers UPDATE RLS.
//
// Bagian dari GATE ERP Master Data Adaptation & Direct Edit UX:
//  1. Cross-tenant UPDATE (produk & pelanggan) harus ditolak RLS, apa pun
//     permission actor di tenant-nya sendiri.
//  2. Regresi utama gate ini: RLS "customers_update" sebelumnya mensyaratkan
//     permission `customers.manage` (tidak match `customers.update` yang
//     dipakai app-layer/role seed) -- role `admin` (punya `customers.update`,
//     TIDAK punya `customers.manage`) lolos app-layer tapi diam-diam
//     diblokir RLS. Migration 20260918000002_fix_customers_update_rls.sql
//     memperbaikinya -- test ini membuktikan admin BISA update pelanggan di
//     tenant sendiri setelah fix, dan TETAP tidak bisa lintas tenant.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback -- pola identik dengan
// imports/commit-invalid-status.integration.test.ts (lihat file itu untuk
// penjelasan safety guard lengkap). TIDAK PERNAH menyentuh Supabase hosted:
// describeIfDb selalu describe.skip kecuali URL loopback murni.
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
  // SAFETY GUARD -- dievaluasi SEBELUM raw.url dipakai untuk createClient() di mana pun.
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("DB integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("products/customers UPDATE RLS -- cross-tenant rejection & admin fix (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  let ownerAAuthId = "";
  let adminAAuthId = "";
  let ownerBAuthId = "";
  const productAId = randomUUID();
  const customerAId = randomUUID();
  const password = randomUUID();

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createClient(env!.url, env!.serviceRoleKey);

    const { data: roles } = await service.from("roles").select("id, name").in("name", ["owner", "admin"]);
    const ownerRoleId = (roles as { id: string; name: string }[]).find((r) => r.name === "owner")!.id;
    const adminRoleId = (roles as { id: string; name: string }[]).find((r) => r.name === "admin")!.id;

    const emails = {
      ownerA: `${runTag}-owner-a@verify.test`,
      adminA: `${runTag}-admin-a@verify.test`,
      ownerB: `${runTag}-owner-b@verify.test`,
    };

    const { data: ownerAAuth, error: ownerAErr } = await service.auth.admin.createUser({ email: emails.ownerA, password, email_confirm: true });
    if (ownerAErr || !ownerAAuth.user) throw new Error(`gagal buat owner A: ${ownerAErr?.message}`);
    ownerAAuthId = ownerAAuth.user.id;

    const { data: adminAAuth, error: adminAErr } = await service.auth.admin.createUser({ email: emails.adminA, password, email_confirm: true });
    if (adminAErr || !adminAAuth.user) throw new Error(`gagal buat admin A: ${adminAErr?.message}`);
    adminAAuthId = adminAAuth.user.id;

    const { data: ownerBAuth, error: ownerBErr } = await service.auth.admin.createUser({ email: emails.ownerB, password, email_confirm: true });
    if (ownerBErr || !ownerBAuth.user) throw new Error(`gagal buat owner B: ${ownerBErr?.message}`);
    ownerBAuthId = ownerBAuth.user.id;

    await service.from("companies").insert([
      { id: companyAId, name: `Verify Co A ${runTag}`, slug: `verify-a-${runTag}` },
      { id: companyBId, name: `Verify Co B ${runTag}`, slug: `verify-b-${runTag}` },
    ]);
    await service.from("users").insert([
      { id: ownerAAuthId, company_id: companyAId, email: emails.ownerA, full_name: "Owner A", is_active: true },
      { id: adminAAuthId, company_id: companyAId, email: emails.adminA, full_name: "Admin A", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: emails.ownerB, full_name: "Owner B", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAAuthId, company_id: companyAId, role_id: ownerRoleId },
      { user_id: adminAAuthId, company_id: companyAId, role_id: adminRoleId },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: ownerRoleId },
    ]);

    await service.from("products").insert({
      id: productAId, company_id: companyAId, sku: `SKU-${runTag}`, name: "Produk Tenant A", price: 10000, created_by: ownerAAuthId,
    });
    await service.from("customers").insert({
      id: customerAId, company_id: companyAId, code: `CUST-${runTag}`, name: "Toko Tenant A", created_by: ownerAAuthId,
    });
  });

  afterAll(async () => {
    if (!service) return;
    await service.from("products").delete().eq("company_id", companyAId);
    await service.from("customers").delete().eq("company_id", companyAId);
    await service.from("user_roles").delete().in("company_id", [companyAId, companyBId]);
    await service.from("users").delete().in("id", [ownerAAuthId, adminAAuthId, ownerBAuthId]);
    await service.from("companies").delete().in("id", [companyAId, companyBId]);
    if (ownerAAuthId) await service.auth.admin.deleteUser(ownerAAuthId);
    if (adminAAuthId) await service.auth.admin.deleteUser(adminAAuthId);
    if (ownerBAuthId) await service.auth.admin.deleteUser(ownerBAuthId);
  }, 30000);

  it("owner tenant lain TIDAK BISA update produk tenant A (RLS products_update, cross-tenant)", async () => {
    const asOwnerB = await signIn(`${runTag}-owner-b@verify.test`);
    const { data } = await asOwnerB.from("products").update({ name: "Diubah Paksa" }).eq("id", productAId).select();
    expect(data ?? []).toHaveLength(0); // RLS: 0 baris ter-update, bukan error -- tetap harus tidak ada efek.
    const { data: check } = await service.from("products").select("name").eq("id", productAId).single();
    expect((check as { name: string }).name).toBe("Produk Tenant A");
  });

  it("owner tenant lain TIDAK BISA update pelanggan tenant A (RLS customers_update, cross-tenant)", async () => {
    const asOwnerB = await signIn(`${runTag}-owner-b@verify.test`);
    const { data } = await asOwnerB.from("customers").update({ name: "Diubah Paksa" }).eq("id", customerAId).select();
    expect(data ?? []).toHaveLength(0);
    const { data: check } = await service.from("customers").select("name").eq("id", customerAId).single();
    expect((check as { name: string }).name).toBe("Toko Tenant A");
  });

  it("REGRESI: admin (customers.update, bukan customers.manage) BISA update pelanggan di tenant sendiri setelah fix RLS", async () => {
    const asAdminA = await signIn(`${runTag}-admin-a@verify.test`);
    const { data, error } = await asAdminA.from("customers").update({ name: "Diedit Admin A" }).eq("id", customerAId).select();
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
    const { data: check } = await service.from("customers").select("name").eq("id", customerAId).single();
    expect((check as { name: string }).name).toBe("Diedit Admin A");
  });
});
