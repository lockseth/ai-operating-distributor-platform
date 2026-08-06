// =============================================================================
// Gate 3E-D4-C1 -- Special Price Approval Schema & State Machine Foundation,
// DB-backed (Postgres/Supabase NYATA, bukan mock). Membuktikan migration
// 20260923000001_gate_3e_d4_c1_special_price_approval_schema.sql terhadap
// kontrak gate:
//   - special_price_approval_requests / special_price_approval_lines: child
//     table terstruktur, tenant-scoped, fail-closed.
//   - Invariant DB (trigger, BUKAN RLS saja): tenant match, requester = sales
//     pemilik order, decider strictly role owner AKTIF tenant sama, versi
//     unik & meningkat, snapshot immutable, keputusan final immutable, satu
//     PENDING aktif per order, harga positif & proposed <= master.
//   - sales_orders.status menerima 'pending_owner_approval' (CHECK
//     constraint) TAPI tidak ada jalur direct-client (RLS) atau RPC generik
//     (update_sales_order_status_atomic) yang bisa menetapkannya pada gate
//     ini -- hanya service-role langsung (mensimulasikan RPC submit-proposal
//     gate berikutnya) yang bisa.
//   - Baseline create/update/confirm order TIDAK regresi.
//
// Semua setup/assert invariant lintas tenant memakai client SERVICE-ROLE
// (bypass total RLS) -- trigger tabel berjalan untuk SEMUA jalur tulis
// termasuk service_role (pola identik gate-3d-b1-single-owner-enforcement).
// Uji direct-client (RLS + REVOKE) memakai client authenticated hasil
// sign-in sungguhan, pola identik sales-auto-attribution.integration.test.ts.
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

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-D4-C1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D4-C1: special price approval schema & state machine foundation (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const companyB = randomUUID(); // tenant lain -- cross-tenant negative tests

  const authIds: Record<string, string> = {};
  let productA1 = "";
  let productA2 = "";
  let productB1 = "";
  let policyA = "";
  let policyB = "";
  let customerA = "";
  let customerB = "";

  const orderIds: string[] = [];
  const spawnedApprovalIds: string[] = [];

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign-in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  async function makeUser(key: string, companyId: string, roleName: string): Promise<string> {
    const email = `${runTag}-${key}@itest.test`;
    const { data: auth, error: authErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (authErr || !auth.user) throw new Error(`gagal buat auth user ${key}: ${authErr?.message}`);
    authIds[key] = auth.user.id;
    const { error: profileErr } = await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${key}`, is_active: true });
    if (profileErr) throw new Error(`gagal buat profile user ${key}: ${profileErr.message}`);
    const { data: roleRow } = await service.from("roles").select("id").eq("name", roleName).is("company_id", null).single();
    const { error: roleErr } = await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    if (roleErr) throw new Error(`gagal assign role ${roleName} untuk ${key}: ${roleErr.message}`);
    return auth.user.id;
  }

  async function makeDraftOrder(companyId: string, customerId: string, salesId: string, productId: string): Promise<string> {
    const orderNumber = `SO-G3ED4C1-${runTag}-${orderIds.length}`;
    const { data, error } = await service.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_id: customerId, sales_id: salesId,
      status: "draft", total_amount: 100000, final_amount: 100000,
    }).select("id").single();
    if (error) throw new Error(`gagal buat draft order: ${error.message}`);
    const orderId = (data as { id: string }).id;
    orderIds.push(orderId);
    const { error: itemErr } = await service.from("sales_order_items").insert({
      order_id: orderId, product_id: productId, quantity: 10, unit_price: 10000, total_amount: 100000,
    });
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    return orderId;
  }

  function baseLine(overrides: Record<string, unknown> = {}) {
    return {
      line_number: 1,
      product_id: productA1,
      product_name_snapshot: "Produk A1",
      quantity: 10,
      master_unit_price: 10000,
      proposed_unit_price: 9000,
      effective_floor_unit_price: 9500,
      ...overrides,
    };
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C1 A ${runTag}`, slug: `g3ed4c1-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C1 B ${runTag}`, slug: `g3ed4c1-b-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("managerA", companyA, "manager");
    await makeUser("adminA", companyA, "admin");
    await makeUser("salesA1", companyA, "sales");
    await makeUser("salesA2", companyA, "sales");
    await makeUser("ownerB", companyB, "owner");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerA = (cA as { id: string }).id;
    const { data: cB } = await service.from("customers").insert({ company_id: companyB, code: `CB-${runTag}`, name: "Toko B" }).select("id").single();
    customerB = (cB as { id: string }).id;

    const { data: pA1 } = await service.from("products").insert({ company_id: companyA, sku: `SKU-A1-${runTag}`, name: "Produk A1", price: 10000 }).select("id").single();
    productA1 = (pA1 as { id: string }).id;
    const { data: pA2 } = await service.from("products").insert({ company_id: companyA, sku: `SKU-A2-${runTag}`, name: "Produk A2", price: 5000 }).select("id").single();
    productA2 = (pA2 as { id: string }).id;
    const { data: pB1 } = await service.from("products").insert({ company_id: companyB, sku: `SKU-B1-${runTag}`, name: "Produk B1", price: 20000 }).select("id").single();
    productB1 = (pB1 as { id: string }).id;

    const { data: polA } = await service.from("knowledge_discount_policies").insert({ company_id: companyA, scope: "global", max_percentage: 10 }).select("id").single();
    policyA = (polA as { id: string }).id;
    const { data: polB } = await service.from("knowledge_discount_policies").insert({ company_id: companyB, scope: "global", max_percentage: 10 }).select("id").single();
    policyB = (polB as { id: string }).id;
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("special_price_approval_lines").delete().in("approval_request_id", spawnedApprovalIds);
    await service.from("special_price_approval_requests").delete().in("id", spawnedApprovalIds);
    await service.from("sales_order_items").delete().in("order_id", orderIds);
    await service.from("sales_orders").delete().in("id", orderIds);
    await service.from("knowledge_discount_policies").delete().in("id", [policyA, policyB].filter(Boolean));
    await service.from("products").delete().in("id", [productA1, productA2, productB1].filter(Boolean));
    await service.from("customers").delete().in("id", [customerA, customerB].filter(Boolean));
    await service.from("user_roles").delete().in("company_id", [companyA, companyB]);
    const allIds = Object.values(authIds).filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyA, companyB]);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  // ---------------------------------------------------------------------
  // 1. sales_orders.status -- nilai baru diterima, tapi tidak ada jalur
  //    direct-client/RPC generik yang bisa menetapkannya.
  // ---------------------------------------------------------------------

  describe("1. sales_orders.status = pending_owner_approval", () => {
    it("1a. CHECK constraint MENERIMA nilai baru lewat service-role langsung (simulasi RPC submit-proposal gate berikutnya)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("sales_orders").update({ status: "pending_owner_approval" }).eq("id", orderId);
      expect(error).toBeNull();
      const { data } = await service.from("sales_orders").select("status").eq("id", orderId).single();
      expect((data as { status: string }).status).toBe("pending_owner_approval");
    });

    it("1b. update_sales_order_status_atomic MENOLAK p_new_status='pending_owner_approval' (special_price_approval_workflow_required)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data } = await service.rpc("update_sales_order_status_atomic", {
        p_company_id: companyA, p_actor_id: authIds.ownerA, p_order_id: orderId, p_new_status: "pending_owner_approval",
      });
      expect((data as { result_outcome: string }[])[0].result_outcome).toBe("special_price_approval_workflow_required");
      const { data: row } = await service.from("sales_orders").select("status").eq("id", orderId).single();
      expect((row as { status: string }).status).toBe("draft");
    });

    it("1c. update_sales_order_status_atomic MENOLAK mutasi apa pun ketika order SUDAH pending_owner_approval (pending_owner_approval_locked)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      await service.from("sales_orders").update({ status: "pending_owner_approval" }).eq("id", orderId);
      const { data } = await service.rpc("update_sales_order_status_atomic", {
        p_company_id: companyA, p_actor_id: authIds.ownerA, p_order_id: orderId, p_new_status: "confirmed",
      });
      expect((data as { result_outcome: string }[])[0].result_outcome).toBe("pending_owner_approval_locked");
    });

    it("1d. Direct-client UPDATE (authenticated, orders.manage) MENOLAK set status='pending_owner_approval' (RLS WITH CHECK)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const managerClient = await signIn(`${runTag}-managerA@itest.test`);
      const { error } = await managerClient.from("sales_orders").update({ status: "pending_owner_approval" }).eq("id", orderId);
      expect(error).not.toBeNull();
      const { data: row } = await service.from("sales_orders").select("status").eq("id", orderId).single();
      expect((row as { status: string }).status).toBe("draft");
    });

    it("1e. Direct-client INSERT (authenticated, orders.create) MENOLAK status='pending_owner_approval' pada order baru (RLS WITH CHECK)", async () => {
      const managerClient = await signIn(`${runTag}-managerA@itest.test`);
      const { error } = await managerClient.from("sales_orders").insert({
        company_id: companyA, order_number: `SO-G3ED4C1-DIRECT-${runTag}`, customer_id: customerA, sales_id: authIds.salesA1,
        status: "pending_owner_approval", total_amount: 0, final_amount: 0,
      });
      expect(error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 2. Baseline order flow tidak regresi (create/update/confirm RPC canonical)
  // ---------------------------------------------------------------------

  describe("2. Baseline order flow (regression -- tidak boleh terpengaruh gate ini)", () => {
    it("2a. create_sales_order_atomic -> update_sales_order_atomic -> confirm_sales_order_atomic tetap PASS end-to-end", async () => {
      const { data: created } = await service.rpc("create_sales_order_atomic", {
        p_company_id: companyA, p_actor_id: authIds.salesA1, p_order_number: `SO-G3ED4C1-E2E-${runTag}`,
        p_customer_id: customerA, p_sales_id: authIds.salesA1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productA1, quantity: 2, unit_price: 10000, discount_amount: 0, total_amount: 20000, notes: null }],
      });
      const createdRow = (created as { result_outcome: string; result_order_id: string }[])[0];
      expect(createdRow.result_outcome).toBe("created");
      orderIds.push(createdRow.result_order_id);

      const { data: updated } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyA, p_actor_id: authIds.salesA1, p_order_id: createdRow.result_order_id,
        p_customer_id: customerA, p_sales_id: authIds.salesA1, p_notes: "updated", p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productA1, quantity: 3, unit_price: 10000, discount_amount: 0, total_amount: 30000, notes: null }],
      });
      expect((updated as { result_outcome: string }[])[0].result_outcome).toBe("updated");

      const { data: confirmed } = await service.rpc("confirm_sales_order_atomic", {
        p_company_id: companyA, p_actor_id: authIds.salesA1, p_order_id: createdRow.result_order_id, p_payment_terms_days: null,
      });
      expect((confirmed as { result_outcome: string }[])[0].result_outcome).toBe("confirmed");
    });

    it("2b. Order confirmed tetap immutable lewat update_sales_order_atomic (invalid_status) -- tidak berubah oleh gate ini", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      await service.rpc("confirm_sales_order_atomic", { p_company_id: companyA, p_actor_id: authIds.salesA1, p_order_id: orderId, p_payment_terms_days: null });
      const { data } = await service.rpc("update_sales_order_atomic", {
        p_company_id: companyA, p_actor_id: authIds.salesA1, p_order_id: orderId,
        p_customer_id: customerA, p_sales_id: authIds.salesA1, p_notes: null, p_delivery_date: null,
        p_discount_amount: 0, p_items: [{ product_id: productA1, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
      });
      expect((data as { result_outcome: string }[])[0].result_outcome).toBe("invalid_status");
    });
  });

  // ---------------------------------------------------------------------
  // 3. special_price_approval_requests -- invariant inti
  // ---------------------------------------------------------------------

  describe("3. special_price_approval_requests -- invariant tenant/requester/versi", () => {
    it("3a. INSERT valid (tenant sama, requested_by = sales pemilik order, versi 1) BERHASIL", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data, error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3a`,
      }).select("id").single();
      expect(error).toBeNull();
      spawnedApprovalIds.push((data as { id: string }).id);
    });

    it("3b. company_id request BEDA dari company_id order DITOLAK (AODP_SPAR_TENANT_MISMATCH)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("special_price_approval_requests").insert({
        company_id: companyB, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3b`,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_TENANT_MISMATCH");
    });

    it("3c. requested_by BUKAN sales pemilik order (sales lain di tenant sama) DITOLAK (AODP_SPAR_REQUESTER_MISMATCH)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA2,
        order_snapshot_hash: `hash-${runTag}-3c`,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_REQUESTER_MISMATCH");
    });

    it("3d. Hanya SATU request PENDING aktif per order -- request PENDING kedua DITOLAK (unique index)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: first, error: firstErr } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3d-1`,
      }).select("id").single();
      expect(firstErr).toBeNull();
      spawnedApprovalIds.push((first as { id: string }).id);

      const { error: secondErr } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 2, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3d-2`,
      });
      expect(secondErr).not.toBeNull();
      expect(secondErr!.code).toBe("23505");
    });

    it("3e. proposal_version duplikat untuk order yang sama DITOLAK (duplikat = tidak meningkat, trigger AODP_SPAR_VERSION_NOT_INCREASING menolak lebih dulu daripada unique constraint)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      // Insert wajib PENDING (invariant #g) -- decide dulu lewat UPDATE supaya
      // slot "satu PENDING aktif" bebas untuk percobaan version duplikat.
      const { data: first, error: firstErr } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3e-1`,
      }).select("id").single();
      expect(firstErr).toBeNull();
      const firstId = (first as { id: string }).id;
      spawnedApprovalIds.push(firstId);
      const { error: decideErr } = await service.from("special_price_approval_requests").update({
        status: "REJECTED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", firstId);
      expect(decideErr).toBeNull();

      const { error: dupErr } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3e-2`,
      });
      expect(dupErr).not.toBeNull();
      expect(["23505", "23514"]).toContain(dupErr!.code);
    });

    it("3f. proposal_version TIDAK meningkat (mis. insert version=1 setelah version=2 sudah ada) DITOLAK (AODP_SPAR_VERSION_NOT_INCREASING)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: v2, error: v2Err } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 2, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3f-1`,
      }).select("id").single();
      expect(v2Err).toBeNull();
      const v2Id = (v2 as { id: string }).id;
      spawnedApprovalIds.push(v2Id);
      const { error: decideErr } = await service.from("special_price_approval_requests").update({
        status: "REJECTED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", v2Id);
      expect(decideErr).toBeNull();

      const { error: v1Err } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-3f-2`,
      });
      expect(v1Err).not.toBeNull();
      expect(v1Err!.message).toContain("AODP_SPAR_VERSION_NOT_INCREASING");
    });

    it("3g. status awal selain PENDING pada INSERT DITOLAK (constraint chk_spar_decision_consistency)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        status: "APPROVED", order_snapshot_hash: `hash-${runTag}-3g`,
      });
      expect(error).not.toBeNull();
    });

    it("3h. status PENDING dengan decided_by terisi DITOLAK (constraint chk_spar_decision_consistency)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        status: "PENDING", decided_by: authIds.ownerA, order_snapshot_hash: `hash-${runTag}-3h`,
      });
      expect(error).not.toBeNull();
    });

    it("3i. order_snapshot_hash kosong DITOLAK (CHECK length > 0)", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: "",
      });
      expect(error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 4. Keputusan Owner -- strictly owner, tenant sama, immutable
  // ---------------------------------------------------------------------

  describe("4. Keputusan (decided_by) -- strictly owner, tenant sama, immutable", () => {
    async function pendingRequest(): Promise<{ orderId: string; requestId: string }> {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data, error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-decision-${orderId}`,
      }).select("id").single();
      if (error) throw error;
      const requestId = (data as { id: string }).id;
      spawnedApprovalIds.push(requestId);
      return { orderId, requestId };
    }

    it("4a. decided_by = manager (non-owner, tenant sama) DITOLAK (AODP_SPAR_DECIDER_NOT_OWNER)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({
        status: "APPROVED", decided_by: authIds.managerA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_DECIDER_NOT_OWNER");
    });

    it("4b. decided_by = admin (non-owner, tenant sama) DITOLAK (AODP_SPAR_DECIDER_NOT_OWNER)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({
        status: "REJECTED", decided_by: authIds.adminA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_DECIDER_NOT_OWNER");
    });

    it("4c. decided_by = sales (pemilik order sendiri) DITOLAK (AODP_SPAR_DECIDER_NOT_OWNER)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({
        status: "APPROVED", decided_by: authIds.salesA1, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_DECIDER_NOT_OWNER");
    });

    it("4d. decided_by = owner TENANT LAIN (companyB) DITOLAK (AODP_SPAR_DECIDER_NOT_OWNER)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({
        status: "APPROVED", decided_by: authIds.ownerB, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_DECIDER_NOT_OWNER");
    });

    it("4e. decided_by = owner TENANT SAMA BERHASIL (APPROVED)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({
        status: "APPROVED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).toBeNull();
    });

    it("4f. Keputusan final (APPROVED) TIDAK dapat diubah lagi -- percobaan flip ke REJECTED DITOLAK (AODP_SPAR_DECISION_IMMUTABLE)", async () => {
      const { requestId } = await pendingRequest();
      await service.from("special_price_approval_requests").update({
        status: "APPROVED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);

      const { error } = await service.from("special_price_approval_requests").update({
        status: "REJECTED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_DECISION_IMMUTABLE");
    });

    it("4g. Snapshot proposal (reason/order_snapshot_hash) TIDAK dapat diubah selagi PENDING (AODP_SPAR_SNAPSHOT_IMMUTABLE)", async () => {
      const { requestId } = await pendingRequest();
      const { error } = await service.from("special_price_approval_requests").update({ reason: "diubah setelah dibuat" }).eq("id", requestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_SNAPSHOT_IMMUTABLE");
    });

    it("4h. Rejection mengembalikan keputusan REJECTED yang immutable -- proposal baru (versi berikutnya) untuk order yang sama tetap BISA dibuat", async () => {
      const { orderId, requestId } = await pendingRequest();
      const { error: rejectErr } = await service.from("special_price_approval_requests").update({
        status: "REJECTED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      }).eq("id", requestId);
      expect(rejectErr).toBeNull();

      const { data: v2, error: v2Err } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 2, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-4h-v2`,
      }).select("id").single();
      expect(v2Err).toBeNull();
      spawnedApprovalIds.push((v2 as { id: string }).id);
    });

    it("4i. Delete request lewat client authenticated (bukan service-role) DITOLAK", async () => {
      const { requestId } = await pendingRequest();
      const ownerClient = await signIn(`${runTag}-ownerA@itest.test`);
      const { error } = await ownerClient.from("special_price_approval_requests").delete().eq("id", requestId);
      expect(error).not.toBeNull();
      const { data: stillThere } = await service.from("special_price_approval_requests").select("id").eq("id", requestId).single();
      expect((stillThere as { id: string } | null)?.id).toBe(requestId);
    });
  });

  // ---------------------------------------------------------------------
  // 5. special_price_approval_lines -- snapshot per line, immutable, tenant
  // ---------------------------------------------------------------------

  describe("5. special_price_approval_lines -- snapshot line", () => {
    async function pendingRequestId(): Promise<{ requestId: string; itemId: string }> {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: itemRow, error: itemErr } = await service.from("sales_order_items").select("id").eq("order_id", orderId).single();
      if (itemErr) throw itemErr;
      const itemId = (itemRow as { id: string }).id;
      const { data, error } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-lines-${orderId}`,
      }).select("id").single();
      if (error) throw error;
      const id = (data as { id: string }).id;
      spawnedApprovalIds.push(id);
      return { requestId: id, itemId };
    }

    it("5a. INSERT line valid BERHASIL, implied_discount_percentage dihitung SERVER-SIDE (generated column)", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { data, error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId, policy_id: policyA, policy_scope_snapshot: "global", policy_max_percentage_snapshot: 10 }),
      ).select("implied_discount_percentage").single();
      expect(error).toBeNull();
      // master 10000, proposed 9000 -> diskon 10%
      expect(Number((data as { implied_discount_percentage: string }).implied_discount_percentage)).toBeCloseTo(10, 4);
    });

    it("5b. proposed_unit_price > master_unit_price DITOLAK (chk_spal_price_is_discount)", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId, master_unit_price: 5000, proposed_unit_price: 6000 }),
      );
      expect(error).not.toBeNull();
    });

    it("5c. master_unit_price <= 0 DITOLAK", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId, master_unit_price: 0 }),
      );
      expect(error).not.toBeNull();
    });

    it("5d. proposed_unit_price <= 0 DITOLAK", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId, proposed_unit_price: 0 }),
      );
      expect(error).not.toBeNull();
    });

    it("5e. product_id dari tenant LAIN (companyB) DITOLAK (AODP_SPAL_PRODUCT_TENANT_MISMATCH)", async () => {
      const { requestId } = await pendingRequestId();
      const { error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, product_id: productB1 }),
      );
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAL_PRODUCT_TENANT_MISMATCH");
    });

    it("5f. policy_id dari tenant LAIN (companyB) DITOLAK (AODP_SPAL_POLICY_TENANT_MISMATCH)", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { error } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId, policy_id: policyB }),
      );
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAL_POLICY_TENANT_MISMATCH");
    });

    it("5g. UPDATE line SETELAH dibuat DITOLAK TOTAL, termasuk lewat service-role (AODP_SPAL_IMMUTABLE)", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { data: line } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId }),
      ).select("id").single();

      const { error } = await service.from("special_price_approval_lines").update({ proposed_unit_price: 8000 }).eq("id", (line as { id: string }).id);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAL_IMMUTABLE");
    });

    it("5h. Delete line lewat client authenticated DITOLAK", async () => {
      const { requestId, itemId } = await pendingRequestId();
      const { data: line } = await service.from("special_price_approval_lines").insert(
        baseLine({ approval_request_id: requestId, sales_order_item_id: itemId }),
      ).select("id").single();

      const ownerClient = await signIn(`${runTag}-ownerA@itest.test`);
      const { error } = await ownerClient.from("special_price_approval_lines").delete().eq("id", (line as { id: string }).id);
      expect(error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // 6. RLS SELECT -- tenant + visibilitas Owner vs Sales
  // ---------------------------------------------------------------------

  describe("6. RLS SELECT -- Owner seluruh tenant, Sales hanya proposal order miliknya", () => {
    it("6a. Owner BISA membaca proposal order Sales lain dalam tenant yang sama", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: req } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-6a`,
      }).select("id").single();
      spawnedApprovalIds.push((req as { id: string }).id);

      const ownerClient = await signIn(`${runTag}-ownerA@itest.test`);
      const { data, error } = await ownerClient.from("special_price_approval_requests").select("id").eq("id", (req as { id: string }).id).single();
      expect(error).toBeNull();
      expect((data as { id: string }).id).toBe((req as { id: string }).id);
    });

    it("6b. Sales pemilik order BISA membaca proposal order miliknya sendiri", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: req } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-6b`,
      }).select("id").single();
      spawnedApprovalIds.push((req as { id: string }).id);

      const sales1Client = await signIn(`${runTag}-salesA1@itest.test`);
      const { data, error } = await sales1Client.from("special_price_approval_requests").select("id").eq("id", (req as { id: string }).id).single();
      expect(error).toBeNull();
      expect((data as { id: string }).id).toBe((req as { id: string }).id);
    });

    it("6c. Sales LAIN (bukan pemilik order) TIDAK BISA membaca proposal order tsb", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: req } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-6c`,
      }).select("id").single();
      spawnedApprovalIds.push((req as { id: string }).id);

      const sales2Client = await signIn(`${runTag}-salesA2@itest.test`);
      const { data } = await sales2Client.from("special_price_approval_requests").select("id").eq("id", (req as { id: string }).id).maybeSingle();
      expect(data).toBeNull();
    });

    it("6d. Owner TENANT LAIN (companyB) TIDAK BISA membaca proposal companyA", async () => {
      const orderId = await makeDraftOrder(companyA, customerA, authIds.salesA1, productA1);
      const { data: req } = await service.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1, requested_by: authIds.salesA1,
        order_snapshot_hash: `hash-${runTag}-6d`,
      }).select("id").single();
      spawnedApprovalIds.push((req as { id: string }).id);

      const ownerBClient = await signIn(`${runTag}-ownerB@itest.test`);
      const { data } = await ownerBClient.from("special_price_approval_requests").select("id").eq("id", (req as { id: string }).id).maybeSingle();
      expect(data).toBeNull();
    });
  });
});
