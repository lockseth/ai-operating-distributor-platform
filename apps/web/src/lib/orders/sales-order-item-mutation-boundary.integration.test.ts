// =============================================================================
// Gate 3E-D4-B1 -- Sales Order Item Mutation Boundary -- DB-backed, Postgres/
// Supabase Auth NYATA (bukan mock). Membuktikan migration
// 20260921000001_gate_3e_d4_b1_sales_order_item_mutation_boundary.sql menutup
// bypass direct-client pada sales_order_items yang ditemukan saat audit Gate
// 3E-D4-A: order_items_insert/update/delete lama (20260626000004) hanya
// memeriksa permission generik + company match -- TIDAK PERNAH memeriksa
// status parent order (bisa mutasi item order confirmed/paid/dst) maupun
// ownership (siapa pun ber-orders.update bisa mengubah item order Sales
// LAIN). Pola tes & helper identik dengan
// auth/gate-3b-role-permission-matrix.integration.test.ts (skip graceful
// jika kredensial Supabase lokal tidak tersedia).
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
  console.warn("Gate 3E-D4-B1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D4-B1: sales_order_items mutation boundary (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4b1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  const ACCOUNTS = [
    { key: "owner", role: "owner" },
    { key: "manager", role: "manager" },
    { key: "admin", role: "admin" },
    { key: "sales1", role: "sales" },
    { key: "sales2", role: "sales" },
  ] as const;

  const authIds: Record<string, string> = {};
  let otherOwnerAuthId = "";

  let customerId = "";
  let productId = "";

  let sales1DraftOrderId = "";
  let sales1DraftItemId = "";
  let sales1DraftOrderBId = "";   // draft kedua milik sales1, untuk uji reparent
  let sales1ConfirmedOrderId = "";
  let sales1ConfirmedItemId = "";
  let sales2DraftOrderId = "";
  let sales2DraftItemId = "";
  let otherCompanyOrderId = "";

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign-in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  async function createDraftOrder(salesKey: keyof typeof authIds, tagSuffix: string, cId = companyId): Promise<{ orderId: string; itemId: string }> {
    const { data: orderRpc, error } = await service.rpc("create_sales_order_atomic", {
      p_company_id: cId, p_actor_id: authIds[salesKey], p_order_number: `SO-${tagSuffix}-${runTag}`,
      p_customer_id: customerId, p_sales_id: authIds[salesKey], p_notes: null, p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    if (error) throw new Error(`gagal setup draft order ${tagSuffix}: ${error.message}`);
    const orderId = (orderRpc ?? [])[0]?.result_order_id as string;
    if (!orderId) throw new Error(`gagal setup draft order ${tagSuffix}: RPC tidak mengembalikan order_id`);
    const { data: itemRow } = await service.from("sales_order_items").select("id").eq("order_id", orderId).limit(1).single();
    return { orderId, itemId: (itemRow as { id: string }).id };
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert([
      { id: companyId, name: `Gate 3E-D4-B1 ${runTag}`, slug: `gate-3ed4b1-${runTag}`, legal_address: "Jl. Gate 3E-D4-B1 No. 1", contact_email: "gate3ed4b1@demo.test", contact_phone: "021-5550010", document_number_prefix: "G3EB1" },
      { id: otherCompanyId, name: `Gate 3E-D4-B1 Other ${runTag}`, slug: `gate-3ed4b1-other-${runTag}`, legal_address: "Jl. Gate 3E-D4-B1 No. 2", contact_email: "gate3ed4b1-other@demo.test", contact_phone: "021-5550011", document_number_prefix: "G3EB1O" },
    ]);

    for (const acc of ACCOUNTS) {
      const email = `${runTag}-${acc.key}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${acc.key}: ${authErr?.message}`);
      authIds[acc.key] = auth.user.id;

      await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${acc.key}`, is_active: true });

      const { data: roleRow, error: roleErr } = await service.from("roles").select("id").eq("name", acc.role).is("company_id", null).single();
      if (roleErr || !roleRow) throw new Error(`role '${acc.role}' tidak ditemukan di seed sistem`);
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    }

    // Owner tenant LAIN -- untuk uji cross-tenant.
    const otherOwnerEmail = `${runTag}-other-owner@itest.test`;
    const { data: otherOwnerAuth, error: otherOwnerErr } = await service.auth.admin.createUser({
      email: otherOwnerEmail, password, email_confirm: true,
    });
    if (otherOwnerErr || !otherOwnerAuth.user) throw new Error(`gagal buat auth user other-owner: ${otherOwnerErr?.message}`);
    otherOwnerAuthId = otherOwnerAuth.user.id;
    await service.from("users").insert({ id: otherOwnerAuthId, company_id: otherCompanyId, email: otherOwnerEmail, full_name: "Itest Other Owner", is_active: true });
    const { data: ownerRoleRow } = await service.from("roles").select("id").eq("name", "owner").is("company_id", null).single();
    await service.from("user_roles").insert({ user_id: otherOwnerAuthId, company_id: otherCompanyId, role_id: (ownerRoleRow as { id: string }).id });

    const { data: customer } = await service.from("customers").insert({ company_id: companyId, code: `CUST-${runTag}`, name: "Toko Gate 3E-D4-B1" }).select("id").single();
    customerId = (customer as { id: string }).id;

    const { data: otherCustomer } = await service.from("customers").insert({ company_id: otherCompanyId, code: `CUST-OTHER-${runTag}`, name: "Toko Other Gate 3E-D4-B1" }).select("id").single();
    const otherCustomerId = (otherCustomer as { id: string }).id;

    const { data: product } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${runTag}`, name: "Produk Gate 3E-D4-B1", price: 10000 }).select("id").single();
    productId = (product as { id: string }).id;

    const { data: otherProduct } = await service.from("products").insert({ company_id: otherCompanyId, sku: `SKU-OTHER-${runTag}`, name: "Produk Other Gate 3E-D4-B1", price: 10000 }).select("id").single();
    const otherProductId = (otherProduct as { id: string }).id;

    const draftA = await createDraftOrder("sales1", "DA");
    sales1DraftOrderId = draftA.orderId;
    sales1DraftItemId = draftA.itemId;

    const draftB = await createDraftOrder("sales1", "DB");
    sales1DraftOrderBId = draftB.orderId;

    const draft2 = await createDraftOrder("sales2", "S2");
    sales2DraftOrderId = draft2.orderId;
    sales2DraftItemId = draft2.itemId;

    const toConfirm = await createDraftOrder("sales1", "CS");
    sales1ConfirmedOrderId = toConfirm.orderId;
    sales1ConfirmedItemId = toConfirm.itemId;
    const { data: confirmRpc, error: confirmErr } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: sales1ConfirmedOrderId, p_payment_terms_days: null,
    });
    if (confirmErr || (confirmRpc ?? [])[0]?.result_outcome !== "confirmed") {
      throw new Error(`gagal setup order confirmed: ${confirmErr?.message ?? JSON.stringify(confirmRpc)}`);
    }

    const { data: otherOrderRpc, error: otherOrderErr } = await service.rpc("create_sales_order_atomic", {
      p_company_id: otherCompanyId, p_actor_id: otherOwnerAuthId, p_order_number: `SO-OTH-${runTag}`,
      p_customer_id: otherCustomerId, p_sales_id: otherOwnerAuthId, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [{ product_id: otherProductId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    if (otherOrderErr) throw new Error(`gagal setup order tenant lain: ${otherOrderErr.message}`);
    otherCompanyOrderId = (otherOrderRpc ?? [])[0]?.result_order_id as string;
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("sales_order_items").delete().in("order_id", [
      sales1DraftOrderId, sales1DraftOrderBId, sales2DraftOrderId, sales1ConfirmedOrderId, otherCompanyOrderId,
    ].filter(Boolean));
    await service.from("sales_orders").delete().in("company_id", [companyId, otherCompanyId]);
    await service.from("customers").delete().in("company_id", [companyId, otherCompanyId]);
    await service.from("products").delete().in("company_id", [companyId, otherCompanyId]);
    await service.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    const allIds = [...Object.values(authIds), otherOwnerAuthId].filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyId, otherCompanyId]);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  // ---------------------------------------------------------------------
  // 1. Sales dapat insert/update item pada draft miliknya (direct client).
  //    DELETE langsung TETAP ditolak (role 'sales' tidak pernah memegang
  //    permission 'orders.delete' -- lihat seed 20260707000001, tidak
  //    berubah oleh gate ini) -- kapabilitas "hapus item" bagi Sales tetap
  //    tersedia lewat RPC update_draft_sales_order_atomic (DELETE+INSERT
  //    sebagai SECURITY DEFINER), dibuktikan terpisah di test #8.
  // ---------------------------------------------------------------------
  describe("1. Sales -- mutasi item pada draft miliknya sendiri", () => {
    it("1a. sales1 BERHASIL insert item baru pada draft miliknya", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data, error } = await scoped.from("sales_order_items")
        .insert({ order_id: sales1DraftOrderId, product_id: productId, quantity: 2, unit_price: 5000, total_amount: 10000 })
        .select("id").single();
      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBeTruthy();
    });

    it("1b. sales1 BERHASIL update item existing pada draft miliknya", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data, error } = await scoped.from("sales_order_items")
        .update({ quantity: 3, unit_price: 5000, total_amount: 15000 })
        .eq("id", sales1DraftItemId).select("id").single();
      expect(error).toBeNull();
      expect((data as { id: string } | null)?.id).toBe(sales1DraftItemId);
      const { data: row } = await service.from("sales_order_items").select("quantity").eq("id", sales1DraftItemId).single();
      expect(Number((row as { quantity: number }).quantity)).toBe(3);
    });

    it("1c. sales1 DITOLAK delete item langsung (RLS -- role sales tidak memegang orders.delete, tidak berubah oleh gate ini)", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items").delete().eq("id", sales1DraftItemId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: stillThere } = await service.from("sales_order_items").select("id").eq("id", sales1DraftItemId).maybeSingle();
      expect(stillThere).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 2. Sales TIDAK dapat memutasi draft milik Sales LAIN.
  // ---------------------------------------------------------------------
  describe("2. Sales -- ditolak memutasi draft Sales lain", () => {
    it("2a. sales1 DITOLAK insert item ke draft milik sales2", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items")
        .insert({ order_id: sales2DraftOrderId, product_id: productId, quantity: 1, unit_price: 1, total_amount: 1 })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("2b. sales1 DITOLAK update item milik draft sales2 (0 baris terpengaruh)", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items").update({ quantity: 99 }).eq("id", sales2DraftItemId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: unchanged } = await service.from("sales_order_items").select("quantity").eq("id", sales2DraftItemId).single();
      expect(Number((unchanged as { quantity: number }).quantity)).not.toBe(99);
    });

    it("2c. sales1 DITOLAK delete item milik draft sales2", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items").delete().eq("id", sales2DraftItemId).select("id");
      expect(data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 3 & 4. Sales TIDAK dapat memutasi order miliknya sendiri yang sudah
  //    confirmed -- termasuk unit_price -- lewat direct client.
  // ---------------------------------------------------------------------
  describe("3-4. Order confirmed -- item tidak bisa dimutasi langsung, termasuk oleh pemiliknya sendiri", () => {
    it("3a. sales1 DITOLAK insert item baru pada order miliknya yang sudah confirmed", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items")
        .insert({ order_id: sales1ConfirmedOrderId, product_id: productId, quantity: 1, unit_price: 1, total_amount: 1 })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("4a. sales1 DITOLAK mengubah unit_price item pada order miliknya yang sudah confirmed", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items").update({ unit_price: 1 }).eq("id", sales1ConfirmedItemId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: unchanged } = await service.from("sales_order_items").select("unit_price").eq("id", sales1ConfirmedItemId).single();
      expect(Number((unchanged as { unit_price: number }).unit_price)).toBe(10000);
    });

    it("4b. sales1 DITOLAK delete item pada order miliknya yang sudah confirmed", async () => {
      const scoped = await signIn(`${runTag}-sales1@itest.test`);
      const { data } = await scoped.from("sales_order_items").delete().eq("id", sales1ConfirmedItemId).select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("4c. owner (orders.manage) TETAP DITOLAK mengubah unit_price pada order confirmed -- draft-only berlaku universal, bukan cuma Sales", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { data } = await scoped.from("sales_order_items").update({ unit_price: 1 }).eq("id", sales1ConfirmedItemId).select("id");
      expect(data ?? []).toHaveLength(0);
      const { data: unchanged } = await service.from("sales_order_items").select("unit_price").eq("id", sales1ConfirmedItemId).single();
      expect(Number((unchanged as { unit_price: number }).unit_price)).toBe(10000);
    });
  });

  // ---------------------------------------------------------------------
  // 5. Item tidak dapat dipindahkan ke order/company lain lewat UPDATE
  //    (trigger anti-reparent -- berlaku independen dari RLS/role).
  // ---------------------------------------------------------------------
  describe("5. Anti-reparent -- order_id tidak bisa diubah lewat UPDATE", () => {
    it("5a. owner (akses penuh ke DUA draft yang sama-sama boleh dia sentuh) DITOLAK memindahkan item dari draft A ke draft B", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const { error } = await scoped.from("sales_order_items")
        .update({ order_id: sales1DraftOrderBId }).eq("id", sales1DraftItemId);
      expect(error).not.toBeNull();
      const { data: unchanged } = await service.from("sales_order_items").select("order_id").eq("id", sales1DraftItemId).single();
      expect((unchanged as { order_id: string }).order_id).toBe(sales1DraftOrderId);
    });

    it("5b. service_role (bypass RLS total) TETAP DITOLAK oleh trigger saat mencoba reparent item ke company lain", async () => {
      const { error } = await service.from("sales_order_items")
        .update({ order_id: otherCompanyOrderId }).eq("id", sales1DraftItemId);
      expect(error).not.toBeNull();
      const { data: unchanged } = await service.from("sales_order_items").select("order_id").eq("id", sales1DraftItemId).single();
      expect((unchanged as { order_id: string }).order_id).toBe(sales1DraftOrderId);
    });
  });

  // ---------------------------------------------------------------------
  // 6. Actor lintas tenant ditolak.
  // ---------------------------------------------------------------------
  describe("6. Cross-tenant", () => {
    it("6a. owner tenant lain DITOLAK insert item ke order tenant ini", async () => {
      const scoped = await signIn(`${runTag}-other-owner@itest.test`);
      const { data } = await scoped.from("sales_order_items")
        .insert({ order_id: sales1DraftOrderId, product_id: productId, quantity: 1, unit_price: 1, total_amount: 1 })
        .select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it("6b. owner tenant lain DITOLAK update/delete item order tenant ini", async () => {
      const scoped = await signIn(`${runTag}-other-owner@itest.test`);
      const upd = await scoped.from("sales_order_items").update({ quantity: 77 }).eq("id", sales1DraftItemId).select("id");
      expect(upd.data ?? []).toHaveLength(0);
      const del = await scoped.from("sales_order_items").delete().eq("id", sales1DraftItemId).select("id");
      expect(del.data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 7. Owner/Admin -- perilaku sesuai permission canonical yang SUDAH ADA
  //    (bukan role baru): owner/manager (orders.manage) bebas terhadap
  //    SEMUA draft order di tenant; admin (TIDAK memegang orders.manage per
  //    seed 20260707000001) dibatasi ke order miliknya sendiri, PERSIS
  //    pola sales_orders_update yang sudah berlaku untuk sales_orders.
  // ---------------------------------------------------------------------
  describe("7. Owner/Admin -- permission canonical (orders.manage vs tidak)", () => {
    it("7a. owner (orders.manage) BERHASIL insert/update/delete item pada draft milik sales1 (BUKAN order miliknya sendiri)", async () => {
      const scoped = await signIn(`${runTag}-owner@itest.test`);
      const ins = await scoped.from("sales_order_items")
        .insert({ order_id: sales1DraftOrderId, product_id: productId, quantity: 1, unit_price: 1000, total_amount: 1000 })
        .select("id").single();
      expect(ins.error).toBeNull();
      const insertedId = (ins.data as { id: string }).id;

      const upd = await scoped.from("sales_order_items").update({ quantity: 4 }).eq("id", insertedId).select("id");
      expect(upd.data ?? []).toHaveLength(1);

      const del = await scoped.from("sales_order_items").delete().eq("id", insertedId).select("id");
      expect(del.data ?? []).toHaveLength(1);
    });

    it("7b. manager (orders.manage) BERHASIL insert item pada draft milik sales1 (bukti berbasis permission seed, bukan asumsi role)", async () => {
      const scoped = await signIn(`${runTag}-manager@itest.test`);
      const { data, error } = await scoped.from("sales_order_items")
        .insert({ order_id: sales1DraftOrderId, product_id: productId, quantity: 1, unit_price: 500, total_amount: 500 })
        .select("id").single();
      expect(error).toBeNull();
      await service.from("sales_order_items").delete().eq("id", (data as { id: string }).id);
    });

    it("7c. admin (TIDAK memegang orders.manage) DITOLAK memutasi item draft milik sales1 secara langsung", async () => {
      const scoped = await signIn(`${runTag}-admin@itest.test`);
      const ins = await scoped.from("sales_order_items")
        .insert({ order_id: sales1DraftOrderId, product_id: productId, quantity: 1, unit_price: 1, total_amount: 1 })
        .select("id");
      expect(ins.data ?? []).toHaveLength(0);

      const upd = await scoped.from("sales_order_items").update({ quantity: 55 }).eq("id", sales1DraftItemId).select("id");
      expect(upd.data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 8 & 9. Regression -- RPC canonical (Telegram + Web) tetap berfungsi,
  //    dipanggil lewat service_role persis seperti aplikasi nyata
  //    (SECURITY DEFINER, bypass RLS -- tidak boleh terpengaruh policy baru).
  // ---------------------------------------------------------------------
  describe("8-9. Regression -- RPC canonical create/update draft tetap berfungsi", () => {
    it("8. Telegram: create_draft_sales_order_atomic + update_draft_sales_order_atomic tetap berhasil", async () => {
      const { data: createRpc, error: createErr } = await service.rpc("create_draft_sales_order_atomic", {
        p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `SO-TG-${runTag}`,
        p_customer_id: customerId, p_customer_name_raw: null, p_order_source: "FIELD_VISIT",
        p_knowledge_version: "v1", p_extraction_confidence: 0.9, p_missing_fields: [],
        p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
        p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000,
        p_items: [{ product_id: productId, product_name_raw: "Produk Gate 3E-D4-B1", quantity: 1, unit: "pcs", unit_price: 10000, discount_type: null, discount_value: null, amount_before_discount: 10000, discount_amount: 0, discount_exception: false, total_amount: 10000 }],
      });
      expect(createErr).toBeNull();
      const outcome = (createRpc ?? [])[0];
      expect(outcome?.result_outcome).toBe("created");
      const orderId = outcome?.result_order_id as string;

      const { data: updateRpc, error: updateErr } = await service.rpc("update_draft_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderId,
        p_customer_id: customerId, p_customer_name_raw: null, p_order_source: "FIELD_VISIT",
        p_knowledge_version: "v1", p_extraction_confidence: 0.9, p_missing_fields: [],
        p_requires_discount_review: false, p_delivery_note: null,
        p_total_amount: 20000, p_discount_amount: 0, p_final_amount: 20000,
        p_items: [{ product_id: productId, product_name_raw: "Produk Gate 3E-D4-B1", quantity: 2, unit: "pcs", unit_price: 10000, discount_type: null, discount_value: null, amount_before_discount: 20000, discount_amount: 0, discount_exception: false, total_amount: 20000 }],
      });
      expect(updateErr).toBeNull();
      expect((updateRpc ?? [])[0]?.result_outcome).toBe("updated");

      await service.from("sales_order_items").delete().eq("order_id", orderId);
      await service.from("sales_orders").delete().eq("id", orderId);
    });

    it("9. Web: create_sales_order_atomic + update_sales_order_atomic tetap berhasil", async () => {
      const { data: createRpc, error: createErr } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_number: `SO-WEB-${runTag}`,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect(createErr).toBeNull();
      const orderId = (createRpc ?? [])[0]?.result_order_id as string;
      expect(orderId).toBeTruthy();

      const { data: updateRpc, error: updateErr } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "web regression", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 2, unit_price: 10000, discount_amount: 0, total_amount: 20000, notes: null }],
      });
      expect(updateErr).toBeNull();
      expect((updateRpc ?? [])[0]?.result_outcome).toBe("updated");

      await service.from("sales_order_items").delete().eq("order_id", orderId);
      await service.from("sales_orders").delete().eq("id", orderId);
    });
  });

  // ---------------------------------------------------------------------
  // 10. Gate 3E-D4-B2 -- update_sales_order_atomic (RPC canonical) menolak
  //    order confirmed/status final lain TANPA KECUALI, termasuk untuk
  //    actor ownership-bypass. Sebelum gate ini RPC menerima 'draft' ATAU
  //    'confirmed' (migration 20260919000001:318) -- ini adalah jalur
  //    bypass canonical (bukan direct-client) yang ditutup gate 3E-D4-B2.
  // ---------------------------------------------------------------------
  describe("10. Gate 3E-D4-B2 -- RPC canonical menolak mutasi order confirmed/final", () => {
    it("10a. sales1 (pemilik order) DITOLAK (invalid_status) mengubah order miliknya yang sudah confirmed lewat RPC, item/total/tax/audit/KPI TIDAK berubah", async () => {
      const { data: itemsBefore } = await service.from("sales_order_items").select("id, unit_price, quantity").eq("order_id", sales1ConfirmedOrderId);
      const { data: orderBefore } = await service.from("sales_orders")
        .select("notes, total_amount, tax_amount, final_amount").eq("id", sales1ConfirmedOrderId).single();
      const { count: auditBefore } = await service.from("audit_logs")
        .select("id", { count: "exact", head: true }).eq("entity_id", sales1ConfirmedOrderId).eq("action", "order.update");
      const { count: kpiBefore } = await service.from("sales_kpi_achievement_events")
        .select("id", { count: "exact", head: true }).eq("order_id", sales1ConfirmedOrderId);

      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: sales1ConfirmedOrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "percobaan edit confirmed", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 99, unit_price: 1, discount_amount: 0, total_amount: 99, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("invalid_status");

      const { data: itemsAfter } = await service.from("sales_order_items").select("id, unit_price, quantity").eq("order_id", sales1ConfirmedOrderId);
      expect(itemsAfter).toEqual(itemsBefore);
      const { data: orderAfter } = await service.from("sales_orders")
        .select("status, notes, total_amount, tax_amount, final_amount").eq("id", sales1ConfirmedOrderId).single();
      expect((orderAfter as { status: string }).status).toBe("confirmed");
      expect((orderAfter as { notes: string | null }).notes).toBe((orderBefore as { notes: string | null }).notes);
      expect((orderAfter as { total_amount: number }).total_amount).toBe((orderBefore as { total_amount: number }).total_amount);
      expect((orderAfter as { tax_amount: number }).tax_amount).toBe((orderBefore as { tax_amount: number }).tax_amount);
      expect((orderAfter as { final_amount: number }).final_amount).toBe((orderBefore as { final_amount: number }).final_amount);
      const { count: auditAfter } = await service.from("audit_logs")
        .select("id", { count: "exact", head: true }).eq("entity_id", sales1ConfirmedOrderId).eq("action", "order.update");
      expect(auditAfter).toBe(auditBefore);
      const { count: kpiAfter } = await service.from("sales_kpi_achievement_events")
        .select("id", { count: "exact", head: true }).eq("order_id", sales1ConfirmedOrderId);
      expect(kpiAfter).toBe(kpiBefore);
    });

    it("10b. owner (ownership-bypass, orders.manage) TETAP DITOLAK (invalid_status) mengubah order confirmed lewat RPC -- draft-only berlaku universal, bukan cuma Sales", async () => {
      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.owner, p_order_id: sales1ConfirmedOrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "percobaan owner edit confirmed", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 1, discount_amount: 0, total_amount: 1, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("invalid_status");
      const { data: orderRow } = await service.from("sales_orders").select("notes").eq("id", sales1ConfirmedOrderId).single();
      expect((orderRow as { notes: string | null }).notes).not.toBe("percobaan owner edit confirmed");
    });

    it("10c. admin (bypass role) TETAP DITOLAK (invalid_status) mengubah order confirmed lewat RPC", async () => {
      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.admin, p_order_id: sales1ConfirmedOrderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "percobaan admin edit confirmed", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 1, discount_amount: 0, total_amount: 1, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("invalid_status");
    });

    it("10d. Status final lain (cancelled) juga ditolak lewat RPC, bukan cuma confirmed", async () => {
      const cancelledOrder = await createDraftOrder("sales1", "CANC");
      await service.from("sales_orders").update({ status: "cancelled" }).eq("id", cancelledOrder.orderId);

      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.owner, p_order_id: cancelledOrder.orderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "percobaan edit cancelled", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 1, unit_price: 1, discount_amount: 0, total_amount: 1, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("invalid_status");

      await service.from("sales_order_items").delete().eq("order_id", cancelledOrder.orderId);
      await service.from("sales_orders").delete().eq("id", cancelledOrder.orderId);
    });

    it("10e. sales1 (pemilik) TETAP BISA mengubah draft miliknya lewat RPC (regresi -- draft-only bukan berarti seluruh update ditolak)", async () => {
      const draftForUpdate = await createDraftOrder("sales1", "STILLOK");
      const { data, error } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: draftForUpdate.orderId,
        p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "masih boleh diedit selagi draft", p_delivery_date: null,
        p_discount_amount: 0,
        p_items: [{ product_id: productId, quantity: 3, unit_price: 10000, discount_amount: 0, total_amount: 30000, notes: null }],
      });
      expect(error).toBeNull();
      expect((data ?? [])[0]?.result_outcome).toBe("updated");

      await service.from("sales_order_items").delete().eq("order_id", draftForUpdate.orderId);
      await service.from("sales_orders").delete().eq("id", draftForUpdate.orderId);
    });

    it("10f. Race update-vs-confirm: hasil akhir konsisten, tidak ada partial mutation -- lock parent row (FOR UPDATE, sama di kedua RPC) menjamin salah satu resolusi penuh", async () => {
      const raceOrder = await createDraftOrder("sales1", "RACE");
      const { data: originalItemsRaw } = await service.from("sales_order_items").select("unit_price, quantity").eq("order_id", raceOrder.orderId);
      const originalSnapshot = (originalItemsRaw ?? []).map((r) => ({
        unit_price: Number((r as { unit_price: number | string }).unit_price),
        quantity: Number((r as { quantity: number | string }).quantity),
      }));

      const [updateResult] = await Promise.all([
        service.rpc("update_sales_order_atomic", {
          p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: raceOrder.orderId,
          p_customer_id: customerId, p_sales_id: authIds.sales1, p_notes: "race update", p_delivery_date: null,
          p_discount_amount: 0,
          // Gate 3E-D6-A: unit_price DIJAGA SAMA DENGAN products.price (master,
          // lihat createDraftOrder/productId di atas -- price: 10000) supaya
          // test ini murni menguji lock/atomicity race update-vs-confirm,
          // BUKAN special-price enforcement (di luar concern test ini -- angka
          // race sebelumnya, 777, kebetulan < master TANPA policy sehingga
          // confirm_sales_order_atomic SEKARANG benar menolaknya sebagai harga
          // khusus tak disetujui bila update menang race, unrelated dengan
          // invariant lock yang diuji test ini).
          p_items: [{ product_id: productId, quantity: 7, unit_price: 10000, discount_amount: 0, total_amount: 70000, notes: null }],
        }),
        service.rpc("confirm_sales_order_atomic", {
          p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: raceOrder.orderId, p_payment_terms_days: null,
        }),
      ]);

      const { data: finalOrder } = await service.from("sales_orders").select("status").eq("id", raceOrder.orderId).single();
      expect((finalOrder as { status: string }).status).toBe("confirmed");

      const { data: finalItemsRaw } = await service.from("sales_order_items").select("unit_price, quantity").eq("order_id", raceOrder.orderId);
      const finalSnapshot = (finalItemsRaw ?? []).map((r) => ({
        unit_price: Number((r as { unit_price: number | string }).unit_price),
        quantity: Number((r as { quantity: number | string }).quantity),
      }));

      const outcome = (updateResult.data ?? [])[0]?.result_outcome;
      expect(["updated", "invalid_status"]).toContain(outcome);
      if (outcome === "updated") {
        expect(finalSnapshot).toEqual([{ unit_price: 10000, quantity: 7 }]);
      } else {
        expect(finalSnapshot).toEqual(originalSnapshot);
      }

      await service.from("sales_order_items").delete().eq("order_id", raceOrder.orderId);
      await service.from("sales_orders").delete().eq("id", raceOrder.orderId);
    });
  });
});
