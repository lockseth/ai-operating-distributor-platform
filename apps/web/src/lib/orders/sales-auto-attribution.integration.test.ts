// =============================================================================
// Gate 3E-D3-A -- Sales Auto-Attribution Enforcement, DB-backed (Postgres
// nyata via migration 20260919000001_gate_3e_d3_a_sales_auto_attribution.sql).
//
// Membuktikan enforcement TIDAK bisa dilewati lewat pemanggilan RPC/RLS
// langsung (bukan hanya app-layer):
//   A. create_sales_order_atomic / update_sales_order_atomic -- Sales selalu
//      diatribusikan ke dirinya sendiri (p_sales_id dari client diabaikan
//      untuk actor non-bypass), toko milik Sales lain ditolak, toko belum
//      ter-attribute tetap diizinkan (kontrak existing, lihat
//      gate-3b-role-permission-matrix.integration.test.ts #17), owner/admin
//      tetap bebas menjalankan workflow assignment existing.
//   B. customers_insert/customers_update RLS -- Sales (atau role non-bypass
//      lain yang punya customers.create/update) hanya bisa mengatribusikan
//      toko ke dirinya sendiri, tidak bisa menyentuh toko Sales lain, tidak
//      bisa memindahkan attribution menjauh dari dirinya; owner/admin tetap
//      bebas mengelola attribution siapa pun di tenant.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan lib/auth/gate-3b-role-permission-matrix.integration.test.ts.
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
  console.warn("Gate 3E-D3-A integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D3-A: Sales auto-attribution enforcement (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed3a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();
  const companyId = randomUUID();

  const authIds: Record<string, string> = {};
  let customCreatorRoleId = "";
  let customerMineId = "";
  let customerOtherId = "";
  let customerUnassignedId = "";
  let productId = "";
  let orderForSpoofTestId = "";
  let orderForOwnerId = "";

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign-in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert({
      id: companyId, name: `Gate 3E-D3-A ${runTag}`, slug: `gate-3e-d3-a-${runTag}`,
    });

    const ACCOUNTS = ["owner", "admin", "sales1", "sales2"] as const;
    for (const key of ACCOUNTS) {
      const email = `${runTag}-${key}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${key}: ${authErr?.message}`);
      authIds[key] = auth.user.id;
      await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${key}`, is_active: true });
      const { data: roleRow } = await service.from("roles").select("id").eq("name", key === "sales1" || key === "sales2" ? "sales" : key).is("company_id", null).single();
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    }

    // Role company-scoped khusus test ini: HANYA customers.create, TANPA role
    // bypass apa pun -- membuktikan enforcement customers_insert bekerja di
    // level RLS, bukan bergantung pada seed role 'sales' saat ini yang
    // memang tidak memegang customers.create (defense-in-depth untuk role
    // custom/masa depan yang mungkin memegangnya).
    const { data: createPerm } = await service.from("permissions").select("id").eq("name", "customers.create").single();
    const { data: customRole } = await service.from("roles")
      .insert({ company_id: companyId, name: `g3ed3a_creator_${runTag}`, description: "test-only, non-bypass, customers.create", is_system_role: false })
      .select("id").single();
    customCreatorRoleId = (customRole as { id: string }).id;
    await service.from("role_permissions").insert({ role_id: customCreatorRoleId, permission_id: (createPerm as { id: string }).id });

    const creatorEmail = `${runTag}-creator@itest.test`;
    const { data: creatorAuth, error: creatorErr } = await service.auth.admin.createUser({ email: creatorEmail, password, email_confirm: true });
    if (creatorErr || !creatorAuth.user) throw new Error(`gagal buat auth user creator: ${creatorErr?.message}`);
    authIds.creator = creatorAuth.user.id;
    await service.from("users").insert({ id: authIds.creator, company_id: companyId, email: creatorEmail, full_name: "Itest Creator", is_active: true });
    await service.from("user_roles").insert({ user_id: authIds.creator, company_id: companyId, role_id: customCreatorRoleId });

    const { data: cMine } = await service.from("customers").insert({ company_id: companyId, code: `CM-${runTag}`, name: "Toko Milik Sales1", assigned_sales_id: authIds.sales1 }).select("id").single();
    customerMineId = (cMine as { id: string }).id;
    const { data: cOther } = await service.from("customers").insert({ company_id: companyId, code: `CO-${runTag}`, name: "Toko Milik Sales2", assigned_sales_id: authIds.sales2 }).select("id").single();
    customerOtherId = (cOther as { id: string }).id;
    const { data: cUnassigned } = await service.from("customers").insert({ company_id: companyId, code: `CU-${runTag}`, name: "Toko Belum Ada Sales" }).select("id").single();
    customerUnassignedId = (cUnassigned as { id: string }).id;

    const { data: product } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${runTag}`, name: "Produk Gate 3E-D3-A", price: 10000 }).select("id").single();
    productId = (product as { id: string }).id;
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("sales_order_items").delete().in("order_id",
      (await service.from("sales_orders").select("id").eq("company_id", companyId)).data?.map((r: { id: string }) => r.id) ?? []);
    await service.from("sales_orders").delete().eq("company_id", companyId);
    await service.from("customers").delete().eq("company_id", companyId);
    await service.from("products").delete().eq("company_id", companyId);
    await service.from("role_permissions").delete().eq("role_id", customCreatorRoleId);
    await service.from("user_roles").delete().eq("company_id", companyId);
    await service.from("roles").delete().eq("id", customCreatorRoleId);
    const allIds = Object.values(authIds).filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().eq("id", companyId);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  // ---------------------------------------------------------------------
  // A. create_sales_order_atomic
  // ---------------------------------------------------------------------
  describe("A. create_sales_order_atomic", () => {
    it("1. sales1 membuat order untuk toko miliknya sendiri -> created, sales_id = sales1", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-1-${runTag}`,
        p_customer_id: customerMineId, p_sales_id: null, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
      const orderId = (data ?? [])[0]?.result_order_id;
      const { data: row } = await service.from("sales_orders").select("sales_id").eq("id", orderId).single();
      expect((row as { sales_id: string }).sales_id).toBe(authIds.sales1);
    });

    it("2. sales1 membuat order untuk toko BELUM ter-attribute -> created (kontrak existing, bukan self-claim)", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-2-${runTag}`,
        p_customer_id: customerUnassignedId, p_sales_id: null, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
      // Order boleh dibuat, TAPI attribution toko itu sendiri TIDAK berubah
      // (tidak ada auto-claim/transfer toko).
      const { data: c } = await service.from("customers").select("assigned_sales_id").eq("id", customerUnassignedId).single();
      expect((c as { assigned_sales_id: string | null }).assigned_sales_id).toBeNull();
    });

    it("3. sales1 mencoba order untuk toko milik sales2 -> ditolak (customer_not_owned), tidak ada order dibuat", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-3-${runTag}`,
        p_customer_id: customerOtherId, p_sales_id: null, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("customer_not_owned");
      const { count } = await service.from("sales_orders").select("id", { count: "exact", head: true }).eq("order_number", `SO-3-${runTag}`);
      expect(count ?? 0).toBe(0);
    });

    it("4. sales1 SPOOF p_sales_id = sales2 -> order tetap diatribusikan ke sales1 (spoof diabaikan)", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-4-${runTag}`,
        p_customer_id: customerMineId, p_sales_id: authIds.sales2, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
      orderForSpoofTestId = (data ?? [])[0]?.result_order_id;
      const { data: row } = await service.from("sales_orders").select("sales_id").eq("id", orderForSpoofTestId).single();
      expect((row as { sales_id: string }).sales_id).toBe(authIds.sales1);
      expect((row as { sales_id: string }).sales_id).not.toBe(authIds.sales2);
    });

    it("5. owner (bypass) membuat order dan menetapkan sales_id = sales2 secara eksplisit -> tetap berhasil (workflow assignment existing)", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.owner, p_order_number: `SO-5-${runTag}`,
        p_customer_id: customerOtherId, p_sales_id: authIds.sales2, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
      orderForOwnerId = (data ?? [])[0]?.result_order_id;
      const { data: row } = await service.from("sales_orders").select("sales_id").eq("id", orderForOwnerId).single();
      expect((row as { sales_id: string }).sales_id).toBe(authIds.sales2);
    });
  });

  // ---------------------------------------------------------------------
  // B. update_sales_order_atomic
  // ---------------------------------------------------------------------
  describe("B. update_sales_order_atomic", () => {
    it("6. sales1 update order miliknya, SPOOF p_sales_id = sales2 -> tetap sales1 (spoof diabaikan)", async () => {
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderForSpoofTestId,
        p_customer_id: customerMineId, p_sales_id: authIds.sales2, p_notes: "percobaan spoof update", p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("updated");
      const { data: row } = await service.from("sales_orders").select("sales_id").eq("id", orderForSpoofTestId).single();
      expect((row as { sales_id: string }).sales_id).toBe(authIds.sales1);
    });

    it("7. sales1 update order miliknya, ganti customer ke toko milik sales2 -> ditolak (customer_not_owned), order TIDAK berubah", async () => {
      const { data: before } = await service.from("sales_orders").select("customer_id, notes").eq("id", orderForSpoofTestId).single();
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderForSpoofTestId,
        p_customer_id: customerOtherId, p_sales_id: authIds.sales1, p_notes: "percobaan pindah customer", p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("customer_not_owned");
      const { data: after } = await service.from("sales_orders").select("customer_id, notes").eq("id", orderForSpoofTestId).single();
      expect((after as { customer_id: string }).customer_id).toBe((before as { customer_id: string }).customer_id);
      expect((after as { notes: string }).notes).toBe((before as { notes: string }).notes);
    });

    it("8. owner (bypass) mengedit order milik sales2 dan menetapkan sales_id = sales2 -> tetap berhasil (regresi Gate 3B)", async () => {
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.owner, p_order_id: orderForOwnerId,
        p_customer_id: customerOtherId, p_sales_id: authIds.sales2, p_notes: "dibantu owner", p_delivery_date: null,
        p_discount_amount: 100, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("updated");
      const { data: row } = await service.from("sales_orders").select("sales_id, discount_amount").eq("id", orderForOwnerId).single();
      expect((row as { sales_id: string }).sales_id).toBe(authIds.sales2);
      expect(Number((row as { discount_amount: number }).discount_amount)).toBe(100);
    });
  });

  // ---------------------------------------------------------------------
  // C. customers_insert / customers_update RLS
  // ---------------------------------------------------------------------
  describe("C. customers RLS -- attribution integrity", () => {
    it("9. sales1 update field non-attribution (phone) pada toko miliknya sendiri -> berhasil", async () => {
      const asSales1 = await signIn(`${runTag}-sales1@itest.test`);
      const { data, error } = await asSales1.from("customers").update({ phone: "081200000001" }).eq("id", customerMineId).select("id");
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(1);
    });

    it("10. sales1 mencoba update toko milik sales2 -> 0 baris terpengaruh (RLS blokir, bukan cuma UI)", async () => {
      const asSales1 = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await asSales1.from("customers").update({ phone: "081299999999" }).eq("id", customerOtherId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: check } = await service.from("customers").select("phone").eq("id", customerOtherId).single();
      expect((check as { phone: string | null }).phone).not.toBe("081299999999");
    });

    it("11. sales1 mencoba memindahkan toko miliknya sendiri ke sales2 (assigned_sales_id) -> ditolak, attribution TIDAK berubah", async () => {
      const asSales1 = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await asSales1.from("customers").update({ assigned_sales_id: authIds.sales2 }).eq("id", customerMineId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: check } = await service.from("customers").select("assigned_sales_id").eq("id", customerMineId).single();
      expect((check as { assigned_sales_id: string }).assigned_sales_id).toBe(authIds.sales1);
    });

    it("12. owner (bypass) TETAP bisa memindahkan attribution toko siapa pun (workflow assignment existing tidak berubah)", async () => {
      const asOwner = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await asOwner.from("customers").update({ assigned_sales_id: authIds.sales2 }).eq("id", customerUnassignedId).select("id");
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(1);
      // Kembalikan ke unassigned supaya tidak mempengaruhi test lain yang bergantung padanya.
      await service.from("customers").update({ assigned_sales_id: null }).eq("id", customerUnassignedId);
    });

    it("13. role custom non-bypass (hanya customers.create) insert toko dengan assigned_sales_id = dirinya sendiri -> berhasil", async () => {
      const asCreator = await signIn(`${runTag}-creator@itest.test`);
      const { data, error } = await asCreator.from("customers")
        .insert({ company_id: companyId, code: `CN-${runTag}`, name: "Toko Dibuat Creator", assigned_sales_id: authIds.creator })
        .select("id");
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(1);
    });

    it("14. role custom non-bypass insert toko dengan assigned_sales_id = orang lain -> ditolak RLS", async () => {
      const asCreator = await signIn(`${runTag}-creator@itest.test`);
      const { data } = await asCreator.from("customers")
        .insert({ company_id: companyId, code: `CN2-${runTag}`, name: "Toko Spoof Attribution", assigned_sales_id: authIds.sales1 })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("15. role custom non-bypass insert toko TANPA assigned_sales_id (null) -> ditolak RLS (attribution wajib diri sendiri)", async () => {
      const asCreator = await signIn(`${runTag}-creator@itest.test`);
      const { data } = await asCreator.from("customers")
        .insert({ company_id: companyId, code: `CN3-${runTag}`, name: "Toko Tanpa Attribution" })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });
  });
});
