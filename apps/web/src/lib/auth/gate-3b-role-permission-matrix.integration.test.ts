// =============================================================================
// Gate 3B (Role Permission Matrix & Admin Discount Restriction) -- DB-backed,
// Postgres/Supabase Auth NYATA (bukan mock). Membuktikan migration
// 20260905000001_gate_3b_role_permission_matrix.sql terhadap dua permukaan:
//
//   A. knowledge_discount_policies (kdp_manage RLS) -- LOCK Gate 3B:
//      "pengaturan/kebijakan diskon" owner-only. owner boleh
//      insert/update/delete; admin, sales, role spoof via user_metadata,
//      user non-aktif, dan cross-tenant SEMUA ditolak lewat RLS (bukan
//      hanya UI -- tidak ada UI/route untuk tabel ini, jadi tes ini
//      langsung ke permukaan nyata: Supabase client ter-otentikasi, pola
//      yang persis sama dengan request langsung/forged request).
//
//   B. update_sales_order_atomic ownership boundary -- sales hanya boleh
//      mengedit order miliknya sendiri (sales_id = actor); owner/manager/
//      admin/super_admin tetap boleh mengedit order siapa pun (konsisten
//      dengan kontrak ADMIN "boleh membantu pengelolaan order" dan role
//      bypass array yang sudah ada di sales_orders_select). Diskon
//      TRANSAKSI (bukan kebijakan) tetap bisa diisi admin/sales pada order
//      yang berwenang mereka edit -- membuktikan Gate 3B tidak menyamakan
//      input diskon transaksi dengan pengaturan kebijakan diskon.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola
// identik dengan demo-role-baseline-canonical-membership.integration.test.ts
// dan lib/orders/actions.integration.test.ts.
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
  console.warn("Gate 3B integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3B: role permission matrix -- discount policy owner-only + order ownership boundary (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  const ACCOUNTS = [
    { key: "owner", role: "owner", spoofedMetadataRole: "sales" },
    { key: "admin", role: "admin", spoofedMetadataRole: "owner" },
    { key: "sales1", role: "sales", spoofedMetadataRole: "owner" },
    { key: "sales2", role: "sales", spoofedMetadataRole: "admin" },
  ] as const;

  const authIds: Record<string, string> = {};
  let inactiveOwnerAuthId = "";
  let otherOwnerAuthId = "";

  let customerId = "";
  let productId = "";
  let sales1OrderId = "";

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign-in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert([
      { id: companyId, name: `Gate 3B ${runTag}`, slug: `gate-3b-${runTag}`, legal_address: "Jl. Gate 3B No. 1", contact_email: "gate3b@demo.test", contact_phone: "021-5550000", document_number_prefix: "G3B" },
      { id: otherCompanyId, name: `Gate 3B Other ${runTag}`, slug: `gate-3b-other-${runTag}`, legal_address: "Jl. Gate 3B No. 2", contact_email: "gate3b-other@demo.test", contact_phone: "021-5550001", document_number_prefix: "G3BO" },
    ]);

    for (const acc of ACCOUNTS) {
      const email = `${runTag}-${acc.key}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { role: acc.spoofedMetadataRole, full_name: `Itest ${acc.key}` },
      });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${acc.key}: ${authErr?.message}`);
      authIds[acc.key] = auth.user.id;

      await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${acc.key}`, is_active: true });

      const { data: roleRow, error: roleErr } = await service.from("roles").select("id").eq("name", acc.role).is("company_id", null).single();
      if (roleErr || !roleRow) throw new Error(`role '${acc.role}' tidak ditemukan di seed sistem`);
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    }

    // User owner TIDAK AKTIF -- simulasi "user tanpa membership aktif" pada
    // permukaan kdp_manage secara spesifik (bukan hanya generik seperti Gate 3A).
    const inactiveEmail = `${runTag}-inactive-owner@itest.test`;
    const { data: inactiveAuth, error: inactiveErr } = await service.auth.admin.createUser({
      email: inactiveEmail, password, email_confirm: true,
    });
    if (inactiveErr || !inactiveAuth.user) throw new Error(`gagal buat auth user inactive-owner: ${inactiveErr?.message}`);
    inactiveOwnerAuthId = inactiveAuth.user.id;
    await service.from("users").insert({ id: inactiveOwnerAuthId, company_id: companyId, email: inactiveEmail, full_name: "Itest Inactive Owner", is_active: false });
    const { data: ownerRoleRow } = await service.from("roles").select("id").eq("name", "owner").is("company_id", null).single();
    await service.from("user_roles").insert({ user_id: inactiveOwnerAuthId, company_id: companyId, role_id: (ownerRoleRow as { id: string }).id });

    // Owner tenant LAIN -- untuk uji cross-tenant.
    const otherOwnerEmail = `${runTag}-other-owner@itest.test`;
    const { data: otherOwnerAuth, error: otherOwnerErr } = await service.auth.admin.createUser({
      email: otherOwnerEmail, password, email_confirm: true,
    });
    if (otherOwnerErr || !otherOwnerAuth.user) throw new Error(`gagal buat auth user other-owner: ${otherOwnerErr?.message}`);
    otherOwnerAuthId = otherOwnerAuth.user.id;
    await service.from("users").insert({ id: otherOwnerAuthId, company_id: otherCompanyId, email: otherOwnerEmail, full_name: "Itest Other Owner", is_active: true });
    await service.from("user_roles").insert({ user_id: otherOwnerAuthId, company_id: otherCompanyId, role_id: (ownerRoleRow as { id: string }).id });

    const { data: customer } = await service.from("customers").insert({ company_id: companyId, code: `CUST-${runTag}`, name: "Toko Gate 3B" }).select("id").single();
    customerId = (customer as { id: string }).id;

    const { data: product } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${runTag}`, name: "Produk Gate 3B", price: 10000 }).select("id").single();
    productId = (product as { id: string }).id;

    // Order dibuat & di-assign ke sales1 -- dipakai untuk uji ownership boundary bagian B.
    const { data: orderRpc } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.owner, p_order_number: `SO-G3B-${runTag}`,
      p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    sales1OrderId = (orderRpc ?? [])[0]?.result_order_id;
    if (!sales1OrderId) throw new Error("gagal setup order milik sales1");
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("knowledge_discount_policies").delete().in("company_id", [companyId, otherCompanyId]);
    await service.from("sales_order_items").delete().eq("order_id", sales1OrderId);
    await service.from("sales_orders").delete().in("company_id", [companyId, otherCompanyId]);
    await service.from("customers").delete().eq("id", customerId);
    await service.from("products").delete().eq("id", productId);
    await service.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    const allIds = [...Object.values(authIds), inactiveOwnerAuthId, otherOwnerAuthId].filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyId, otherCompanyId]);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  // ---------------------------------------------------------------------
  // A. knowledge_discount_policies -- kdp_manage owner-only
  // ---------------------------------------------------------------------
  describe("A. Discount policy settings (knowledge_discount_policies) -- owner-only", () => {
    it("1. Owner BERHASIL insert kebijakan diskon", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data, error } = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 15, created_by: authIds.owner })
        .select("id").single();
      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBeTruthy();
    });

    it("2. Owner BERHASIL update (nonaktifkan) kebijakan diskon miliknya", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data: rows } = await service.from("knowledge_discount_policies").select("id").eq("company_id", companyId).limit(1);
      const policyId = (rows ?? [])[0]?.id as string;
      const { data, error } = await scoped.from("knowledge_discount_policies").update({ is_active: false }).eq("id", policyId).select("id").single();
      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBe(policyId);
    });

    it("3. Admin DITOLAK insert kebijakan diskon (RLS, bukan hanya UI)", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const { data, error } = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 99, created_by: authIds.admin })
        .select("id");
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it("4. Admin DITOLAK update kebijakan diskon existing (0 baris terpengaruh)", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const { data: rows } = await service.from("knowledge_discount_policies").select("id, max_percentage").eq("company_id", companyId).limit(1);
      const policy = (rows ?? [])[0] as { id: string; max_percentage: number };
      const { data } = await scoped.from("knowledge_discount_policies").update({ max_percentage: 1 }).eq("id", policy.id).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: unchanged } = await service.from("knowledge_discount_policies").select("max_percentage").eq("id", policy.id).single();
      expect(Number((unchanged as { max_percentage: number }).max_percentage)).toBe(Number(policy.max_percentage));
    });

    it("5. Admin DITOLAK delete kebijakan diskon", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const { data: rows } = await service.from("knowledge_discount_policies").select("id").eq("company_id", companyId).limit(1);
      const policyId = (rows ?? [])[0]?.id as string;
      const { data } = await scoped.from("knowledge_discount_policies").delete().eq("id", policyId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: stillThere } = await service.from("knowledge_discount_policies").select("id").eq("id", policyId).maybeSingle();
      expect(stillThere).not.toBeNull();
    });

    it("6. Sales DITOLAK insert/update/delete kebijakan diskon", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const insertAttempt = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 50, created_by: authIds.sales1 })
        .select("id");
      expect(insertAttempt.data ?? []).toHaveLength(0);

      const { data: rows } = await service.from("knowledge_discount_policies").select("id").eq("company_id", companyId).limit(1);
      const policyId = (rows ?? [])[0]?.id as string;
      const updateAttempt = await scoped.from("knowledge_discount_policies").update({ max_percentage: 2 }).eq("id", policyId).select("id");
      expect(updateAttempt.data ?? []).toHaveLength(0);
      const deleteAttempt = await scoped.from("knowledge_discount_policies").delete().eq("id", policyId).select("id");
      expect(deleteAttempt.data ?? []).toHaveLength(0);
    });

    it("7. Role spoof via user_metadata TIDAK berpengaruh -- admin ber-metadata role='owner' tetap ditolak", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const { data: userData } = await scoped.auth.getUser();
      expect((userData.user!.user_metadata as { role?: string } | null)?.role).toBe("owner");

      const { data } = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 77, created_by: authIds.admin })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("8. Owner TANPA membership aktif (is_active=false) DITOLAK insert kebijakan diskon", async () => {
      const scoped = await signIn(`${runTag}-inactive-owner@itest.test`);
      const { data } = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 33, created_by: inactiveOwnerAuthId })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("9. Cross-tenant: owner tenant lain DITOLAK insert kebijakan diskon untuk company_id tenant ini", async () => {
      const scoped = await signIn(`${runTag}-other-owner@itest.test`);
      const { data } = await scoped.from("knowledge_discount_policies")
        .insert({ company_id: companyId, scope: "global", max_percentage: 44, created_by: otherOwnerAuthId })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("10. Cross-tenant: owner tenant lain tidak melihat kebijakan diskon tenant ini (kdp_select tetap company-scoped)", async () => {
      const scoped = await signIn(`${runTag}-other-owner@itest.test`);
      const { data } = await scoped.from("knowledge_discount_policies").select("id").eq("company_id", companyId);
      expect(data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // B. update_sales_order_atomic -- ownership boundary + transaction discount
  // ---------------------------------------------------------------------
  describe("B. Order update ownership boundary (RPC -- jalur mutasi nyata, bukan RLS langsung)", () => {
    // update_sales_order_atomic hanya di-GRANT ke service_role (lihat migration
    // 20260822000001, REVOKE ALL ... FROM PUBLIC, anon, authenticated). Jalur
    // produksi sesungguhnya SELALU lewat getAdminClient() (service-role) --
    // apps/web/src/lib/orders/actions.ts memanggilnya dengan p_actor_id = user
    // yang sudah diautentikasi/di-resolve server-side (getAuthUser()). Tes ini
    // meniru jalur itu persis: pemeriksaan otorisasi yang dibuktikan ada DI
    // DALAM RPC (role/ownership actor), BUKAN pada koneksi yang memanggilnya --
    // sign-in dipakai hanya untuk membuktikan identitas/metadata actor, RPC-nya
    // sendiri dipanggil lewat client service-role persis seperti aplikasi nyata.
    it("11. sales1 (pemilik order) BERHASIL update order miliknya sendiri, termasuk mengisi diskon transaksi", async () => {
      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: sales1OrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "diupdate sales1", p_delivery_date: null,
        p_discount_amount: 500,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("updated");
      const { data: row } = await service.from("sales_orders").select("discount_amount").eq("id", sales1OrderId).single();
      expect(Number((row as { discount_amount: number }).discount_amount)).toBe(500);
    });

    it("12. sales2 (BUKAN pemilik order) DITOLAK (forbidden) mengedit order milik sales1, walau punya permission orders.update", async () => {
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales2, p_order_id: sales1OrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "percobaan sales2", p_delivery_date: null,
        p_discount_amount: 9999,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
      const { data: row } = await service.from("sales_orders").select("discount_amount, notes").eq("id", sales1OrderId).single();
      expect(Number((row as { discount_amount: number }).discount_amount)).not.toBe(9999);
      expect((row as { notes: string }).notes).not.toBe("percobaan sales2");
    });

    it("13. Role spoof via user_metadata TIDAK membantu sales2 melewati ownership boundary (RPC resolve role dari DB via p_actor_id, bukan dari sesi/metadata)", async () => {
      const scoped = await signIn(`${runTag}-sales2@itest.test`);
      const { data: userData } = await scoped.auth.getUser();
      expect((userData.user!.user_metadata as { role?: string } | null)?.role).toBe("admin");

      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales2, p_order_id: sales1OrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 1,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
    });

    it("14. Admin (bypass role, izin operasional dibekukan) BERHASIL mengedit order milik sales1, termasuk mengisi diskon transaksi", async () => {
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.admin, p_order_id: sales1OrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "dibantu admin", p_delivery_date: null,
        p_discount_amount: 750,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("updated");
      const { data: row } = await service.from("sales_orders").select("discount_amount, notes").eq("id", sales1OrderId).single();
      expect(Number((row as { discount_amount: number }).discount_amount)).toBe(750);
      expect((row as { notes: string }).notes).toBe("dibantu admin");
    });

    it("15. Cross-tenant: owner tenant lain DITOLAK mengedit order tenant ini lewat RPC (company_id mismatch -> not_found)", async () => {
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: otherCompanyId, p_actor_id: otherOwnerAuthId, p_order_id: sales1OrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 1,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("not_found");
    });
  });

  // ---------------------------------------------------------------------
  // C. Regression -- izin operasional admin & sales yang DIBEKUKAN tetap bekerja
  // ---------------------------------------------------------------------
  describe("C. Regression -- permission matrix owner/admin/sales tidak berubah di luar lock diskon", () => {
    it("16. Admin masih BISA membuat sales order baru (orders.create tidak diregresi)", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.admin, p_order_number: `SO-G3B-ADMIN-${runTag}`,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
    });

    it("17. Sales masih BISA membuat sales order baru miliknya sendiri (orders.create tidak diregresi)", async () => {
      const { data } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-G3B-SALES-${runTag}`,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data ?? [])[0]?.result_outcome).toBe("created");
    });

    // Seed role_permissions bertumbuh seiring gate lain (imports/knowledge/
    // telegram/delivery/dispatch/reports.create.../dst, ditambahkan migration
    // setelah 20260707000001) -- assert di sini SENGAJA subset/exclusion, bukan
    // exact-equality, supaya tidak rapuh terhadap penambahan permission modul
    // lain yang tidak terkait diskon. Yang wajib benar untuk Gate 3B: permission
    // orders/customers/products/reports/settings/users milik admin dari
    // kontrak awal TETAP ada, dan TIDAK ADA permission bertema diskon/kebijakan
    // apa pun yang pernah ditambahkan ke admin maupun sales.
    it("18. Permission seed admin: kontrak awal Gate 3B tetap utuh, TIDAK ADA permission diskon/kebijakan yang ditambahkan", async () => {
      const { data: roleRow } = await service.from("roles").select("id").eq("name", "admin").is("company_id", null).single();
      const { data: permRows } = await service.from("role_permissions").select("permission:permissions(name)").eq("role_id", (roleRow as { id: string }).id);
      const names = ((permRows ?? []) as unknown as { permission: { name: string } | null }[]).map((r) => r.permission?.name).filter((n): n is string => !!n);
      for (const expected of [
        "customers.create", "customers.update", "customers.view",
        "orders.create", "orders.update", "orders.view",
        "products.create", "products.update", "products.view",
        "reports.export", "reports.view",
        "settings.view",
        "users.view",
      ]) {
        expect(names).toContain(expected);
      }
      expect(names.some((n) => n.startsWith("discount") || n.includes("discount_policy"))).toBe(false);
      expect(names).not.toContain("settings.manage");
      expect(names).not.toContain("users.manage");
      expect(names).not.toContain("companies.manage");
    });

    it("19. Permission seed sales: kontrak awal Gate 3B tetap utuh, TIDAK ADA permission diskon/kebijakan/settings/user-management yang ditambahkan", async () => {
      const { data: roleRow } = await service.from("roles").select("id").eq("name", "sales").is("company_id", null).single();
      const { data: permRows } = await service.from("role_permissions").select("permission:permissions(name)").eq("role_id", (roleRow as { id: string }).id);
      const names = ((permRows ?? []) as unknown as { permission: { name: string } | null }[]).map((r) => r.permission?.name).filter((n): n is string => !!n);
      for (const expected of [
        "ai.view",
        "customers.update", "customers.view",
        "orders.create", "orders.update", "orders.view",
        "products.view",
        "reports.view",
      ]) {
        expect(names).toContain(expected);
      }
      expect(names.some((n) => n.startsWith("discount") || n.includes("discount_policy"))).toBe(false);
      expect(names).not.toContain("settings.view");
      expect(names).not.toContain("settings.manage");
      expect(names).not.toContain("users.view");
      expect(names).not.toContain("users.manage");
    });
  });
});
