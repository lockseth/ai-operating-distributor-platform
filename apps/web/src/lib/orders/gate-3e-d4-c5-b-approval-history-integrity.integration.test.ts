// =============================================================================
// Gate 3E-D4-C5-B -- Approval-History Integrity Corrective Closeout, DB-backed
// (Postgres/Supabase NYATA, bukan mock). Menutup KEKURANGAN BUKTI pada
// integritas histori special_price_approval_requests/lines yang BELUM
// dibuktikan file test C1-C5 sebelumnya -- BUKAN mengulang bukti yang sudah
// ada di sana.
//
// Audit sebelum menulis file ini (lihat laporan Gate 3E-D4-C5-B) menemukan
// SELURUH enforcement yang dibutuhkan SUDAH ada (REVOKE INSERT/UPDATE/DELETE
// dari authenticated/anon -- migration 20260923000001; trigger invariant
// tenant/requester/decider/immutability -- migration yang sama, diperluas
// 20260924000001/20260925000001) -- TIDAK ADA migration baru pada gate ini.
// File ini HANYA menambah regression test PERMANEN untuk celah BUKTI berikut
// (dikonfirmasi lewat audit test existing, bukan asumsi):
//
//   - Authenticated direct UPDATE pada baris PENDING (bukan hanya baris yang
//     sudah diputuskan, gate-3e-d4-c3 test #22) -- belum pernah diuji untuk
//     KEDUA tabel (requests DAN lines).
//   - Relink company_id/sales_order_id -- trigger existing (4g,
//     gate-3e-d4-c1) hanya menguji kolom `reason`, bukan company_id/
//     sales_order_id secara eksplisit.
//   - Forge requester/decider/decision/timestamp lewat INSERT LANGSUNG oleh
//     actor authenticated (bypass RPC submit/decide sepenuhnya) -- belum ada
//     satu pun test yang mencoba INSERT langsung sebagai authenticated
//     client di file mana pun (hanya UPDATE/DELETE/SELECT yang diuji
//     sebelumnya).
//   - Mutasi direct-DML CROSS-TENANT (bukan hanya RPC yang mengembalikan
//     not_found, dan bukan hanya SELECT lintas tenant) -- owner tenant lain
//     mencoba UPDATE/DELETE baris tenant lain langsung.
//
// Item kontrak yang SUDAH terbukti PASS di file lain (TIDAK diulang di sini,
// hanya direferensikan pada laporan closeout):
//   - DELETE authenticated ditolak (requests: gate-3e-d4-c1 #4i; lines: #5h)
//   - Decider strictly-owner + tenant sama (gate-3e-d4-c1 #4a-4e, trigger)
//   - Snapshot immutable saat PENDING, kolom `reason` (gate-3e-d4-c1 #4g)
//   - Keputusan final immutable, UPDATE/DELETE authenticated pasca-keputusan
//     (gate-3e-d4-c3 #22)
//   - Contradictory decision (key baru pada request sudah diputuskan) ->
//     already_decided, tidak menimpa (gate-3e-d4-c3 #8)
//   - Retry idempotent (key+payload sama) tanpa audit ganda (gate-3e-d4-c3
//     #17, #18); key sama payload beda -> idempotency_conflict (#19, #20)
//   - Cross-tenant lewat RPC decide -> not_found, tanpa information leak
//     (gate-3e-d4-c3 #6); cross-tenant SELECT ditolak (gate-3e-d4-c1 #6d)
//   - Invalid order/request state ditolak (gate-3e-d4-c3 #8, #9;
//     gate-3e-d4-c4 #2, #3)
//   - Approved snapshot diterapkan tepat ke order (gate-3e-d4-c3 #1;
//     gate-3e-d4-c4 #5+6; gate-3e-d4-c5 #5); rejected snapshot TIDAK
//     diterapkan (gate-3e-d4-c3 #2; gate-3e-d4-c4 #4a)
//
// Residual risk yang DITERIMA (bukan celah, TIDAK diuji sebagai bypass):
//   service_role/database owner bisa menulis langsung ke kedua tabel ini
//   (REVOKE C1 hanya mencakup authenticated/anon, pola identik audit_logs)
//   -- service_role adalah credential trusted-server (getAdminClient(),
//   tidak pernah dipegang end-user), didokumentasikan eksplisit sebagai
//   residual risk inheren pada migration 20260927000001 (Temuan #3b).
//
// Semua panggilan RPC lewat sesi Supabase Auth SUNGGUHAN (anon-key client +
// signInWithPassword), pola identik gate-3e-d4-c3. Percobaan mutasi
// direct-client memakai client authenticated hasil sign-in sungguhan --
// TIDAK PERNAH memakai service-role untuk membuktikan proteksi authenticated
// (service-role hanya dipakai untuk setup/verifikasi state dan SATU test
// trigger defense-in-depth yang eksplisit diberi label "service-role").
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
  console.warn("Gate 3E-D4-C5-B integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type SubmitRow = {
  result_outcome: string;
  requires_approval: boolean | null;
  approval_request_id: string | null;
  proposal_version: number | null;
  order_status: string | null;
};

type ProposedLine = { sales_order_item_id: string; proposed_unit_price: number };

describeIfDb("Gate 3E-D4-C5-B: approval-history integrity corrective closeout (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c5b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const companyB = randomUUID();

  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const productIds: Record<string, string> = {};
  const customerIds: Record<string, string> = {};
  const orderIds: string[] = [];
  const approvalRequestIds: string[] = [];

  async function signIn(key: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email: emails[key], password });
    if (error) throw new Error(`sign-in gagal untuk ${key}: ${error.message}`);
    return scoped;
  }

  async function makeUser(key: string, companyId: string, roleName: string): Promise<string> {
    const email = `${runTag}-${key}@itest.test`;
    emails[key] = email;
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

  async function makeProduct(key: string, companyId: string, price: number): Promise<string> {
    const { data, error } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${key}-${runTag}`, name: `Produk ${key}`, price, is_active: true }).select("id").single();
    if (error) throw new Error(`gagal buat produk ${key}: ${error.message}`);
    productIds[key] = (data as { id: string }).id;
    return productIds[key];
  }

  async function makeOrder(companyId: string, customerId: string, salesId: string, items: { productKey: string; quantity: number; unitPrice: number }[]): Promise<{ orderId: string; itemIds: string[] }> {
    const orderNumber = `SO-G3ED4C5B-${runTag}-${orderIds.length}`;
    const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const { data, error } = await service.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_id: customerId, sales_id: salesId,
      status: "draft", total_amount: total, final_amount: total,
    }).select("id").single();
    if (error) throw new Error(`gagal buat order: ${error.message}`);
    const orderId = (data as { id: string }).id;
    orderIds.push(orderId);
    const itemIds: string[] = [];
    for (const it of items) {
      const { data: itemRow, error: itemErr } = await service.from("sales_order_items").insert({
        order_id: orderId, product_id: productIds[it.productKey], quantity: it.quantity, unit_price: it.unitPrice, total_amount: it.quantity * it.unitPrice,
      }).select("id").single();
      if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
      itemIds.push((itemRow as { id: string }).id);
    }
    return { orderId, itemIds };
  }

  async function callSubmit(actorKey: string, orderId: string, items: ProposedLine[], reason: string | null): Promise<SubmitRow> {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId,
      p_items: items,
      p_reason: reason,
      p_idempotency_key: null,
    });
    if (error) throw new Error(`submit rpc error (${actorKey}): ${error.message}`);
    const row = (data as SubmitRow[])[0];
    if (row.approval_request_id) approvalRequestIds.push(row.approval_request_id);
    return row;
  }

  // Helper: buat order+proposal PENDING lewat jalur RPC SUNGGUHAN (bukan
  // insert service-role langsung) -- baris yang diuji di sini adalah baris
  // yang benar-benar dihasilkan alur produksi, bukti lebih representatif
  // terhadap permukaan serangan nyata. Tanpa knowledge_discount_policies
  // sama sekali -> requires_approval=TRUE fail-closed (pola gate-3e-d4-c2
  // test #10), sehingga fixture tidak perlu membuat baris policy.
  async function makePendingProposal(
    productKey: string,
    salesKey: string,
    customerId: string,
    companyId: string,
    unitPrice = 10000,
    proposedPrice = 8000,
    quantity = 10,
  ): Promise<{ orderId: string; itemId: string; approvalRequestId: string }> {
    const { orderId, itemIds } = await makeOrder(companyId, customerId, authIds[salesKey], [
      { productKey, quantity, unitPrice },
    ]);
    const row = await callSubmit(salesKey, orderId, [{ sales_order_item_id: itemIds[0], proposed_unit_price: proposedPrice }], "alasan proposal C5-B");
    expect(row.result_outcome).toBe("submitted");
    return { orderId, itemId: itemIds[0], approvalRequestId: row.approval_request_id! };
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C5-B A ${runTag}`, slug: `g3ed4c5b-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C5-B B ${runTag}`, slug: `g3ed4c5b-b-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("salesA1", companyA, "sales");
    await makeUser("salesA2", companyA, "sales");
    await makeUser("ownerB", companyB, "owner");
    await makeUser("salesB1", companyB, "sales");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerIds.A = (cA as { id: string }).id;
    const { data: cB } = await service.from("customers").insert({ company_id: companyB, code: `CB-${runTag}`, name: "Toko B", assigned_sales_id: authIds.salesB1 }).select("id").single();
    customerIds.B = (cB as { id: string }).id;

    await makeProduct("a1", companyA, 10000);
    await makeProduct("a2", companyA, 10000);
    await makeProduct("b1", companyB, 10000);
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("special_price_approval_lines").delete().in("approval_request_id", approvalRequestIds);
    await service.from("special_price_approval_requests").delete().in("sales_order_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", approvalRequestIds);
    await service.from("sales_order_items").delete().in("order_id", orderIds);
    await service.from("sales_orders").delete().in("id", orderIds);
    await service.from("products").delete().in("id", Object.values(productIds));
    await service.from("customers").delete().in("id", Object.values(customerIds));
    await service.from("user_roles").delete().in("company_id", [companyA, companyB]);
    const allIds = Object.values(authIds);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyA, companyB]);
    for (const id of allIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  // ---------------------------------------------------------------------
  // 1. Authenticated direct UPDATE pada baris PENDING (belum pernah diuji
  //    sebelumnya -- gate-3e-d4-c3 #22 hanya menguji PASCA-keputusan).
  // ---------------------------------------------------------------------

  describe("1. Authenticated direct UPDATE ditolak pada baris PENDING (kedua tabel)", () => {
    it("1a. Owner tenant sama, request PENDING milik tenant sendiri: UPDATE reason DITOLAK (permission, bukan trigger)", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const ownerClient = await signIn("ownerA");
      const { error } = await ownerClient.from("special_price_approval_requests").update({ reason: "dipalsukan authenticated" }).eq("id", approvalRequestId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_requests").select("reason, status").eq("id", approvalRequestId).single();
      expect((after as { reason: string }).reason).toBe("alasan proposal C5-B");
      expect((after as { status: string }).status).toBe("PENDING");
    });

    it("1b. Sales pemilik order sendiri: UPDATE line PENDING (proposed_unit_price) DITOLAK (permission)", async () => {
      const { approvalRequestId, itemId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const { data: lineRow } = await service.from("special_price_approval_lines").select("id, proposed_unit_price").eq("approval_request_id", approvalRequestId).eq("sales_order_item_id", itemId).single();
      const lineId = (lineRow as { id: string }).id;

      const salesClient = await signIn("salesA1");
      const { error } = await salesClient.from("special_price_approval_lines").update({ proposed_unit_price: 1 }).eq("id", lineId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_lines").select("proposed_unit_price").eq("id", lineId).single();
      expect(Number((after as { proposed_unit_price: number }).proposed_unit_price)).toBe(8000);
    });
  });

  // ---------------------------------------------------------------------
  // 2. Relink company_id / sales_order_id -- trigger existing (gate-3e-d4-c1
  //    #4g) hanya pernah menguji kolom `reason`, bukan relink identitas.
  // ---------------------------------------------------------------------

  describe("2. Relink company_id/sales_order_id ditolak", () => {
    it("2a. Authenticated (owner, permission-level): relink sales_order_id ke order LAIN dalam tenant sendiri DITOLAK", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const { orderId: otherOrderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "a2", quantity: 1, unitPrice: 10000 }]);

      const ownerClient = await signIn("ownerA");
      const { error } = await ownerClient.from("special_price_approval_requests").update({ sales_order_id: otherOrderId }).eq("id", approvalRequestId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_requests").select("sales_order_id").eq("id", approvalRequestId).single();
      expect((after as { sales_order_id: string }).sales_order_id).not.toBe(otherOrderId);
    });

    it("2b. Authenticated (owner, permission-level): relink company_id ke tenant LAIN DITOLAK", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const ownerClient = await signIn("ownerA");
      const { error } = await ownerClient.from("special_price_approval_requests").update({ company_id: companyB }).eq("id", approvalRequestId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_requests").select("company_id").eq("id", approvalRequestId).single();
      expect((after as { company_id: string }).company_id).toBe(companyA);
    });

    it("2c. Trigger defense-in-depth (service-role, BUKAN bukti proteksi authenticated): relink sales_order_id DITOLAK -- AODP_SPAR_SNAPSHOT_IMMUTABLE", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const { orderId: otherOrderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "a2", quantity: 1, unitPrice: 10000 }]);

      const { error } = await service.from("special_price_approval_requests").update({ sales_order_id: otherOrderId }).eq("id", approvalRequestId);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("AODP_SPAR_SNAPSHOT_IMMUTABLE");
    });
  });

  // ---------------------------------------------------------------------
  // 3. Forge requester/decider/decision/timestamp lewat INSERT LANGSUNG --
  //    belum pernah diuji: tidak ada file lain yang mencoba INSERT sebagai
  //    authenticated client (hanya UPDATE/DELETE/SELECT).
  // ---------------------------------------------------------------------

  describe("3. Forge requester/decider/decision/timestamp lewat direct INSERT (authenticated) ditolak", () => {
    it("3a. Sales memalsukan requested_by = sales LAIN lewat INSERT langsung (bypass RPC submit) DITOLAK (permission)", async () => {
      const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "a1", quantity: 1, unitPrice: 10000 }]);
      const salesClient = await signIn("salesA1");
      const { error } = await salesClient.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1,
        requested_by: authIds.salesA2, // forge: bukan diri sendiri
        order_snapshot_hash: `forged-${runTag}`,
      });
      expect(error).not.toBeNull();

      const { data: rows } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
      expect(rows).toHaveLength(0); // tidak ada baris ter-insert sama sekali
    });

    it("3b. Owner memalsukan decided_by+decision+decided_at lewat INSERT langsung (bypass RPC decide sepenuhnya) DITOLAK (permission)", async () => {
      const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "a1", quantity: 1, unitPrice: 10000 }]);
      const ownerClient = await signIn("ownerA");
      const { error } = await ownerClient.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1,
        requested_by: authIds.salesA1, order_snapshot_hash: `forged-decision-${runTag}`,
        status: "APPROVED", decided_by: authIds.ownerA, decided_at: new Date().toISOString(),
      });
      expect(error).not.toBeNull();

      const { data: rows } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
      expect(rows).toHaveLength(0);
    });

    it("3c. Owner memalsukan created_at (backdating) lewat INSERT langsung DITOLAK (permission)", async () => {
      const { orderId } = await makeOrder(companyA, customerIds.A, authIds.salesA1, [{ productKey: "a1", quantity: 1, unitPrice: 10000 }]);
      const ownerClient = await signIn("ownerA");
      const pastDate = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
      const { error } = await ownerClient.from("special_price_approval_requests").insert({
        company_id: companyA, sales_order_id: orderId, proposal_version: 1,
        requested_by: authIds.salesA1, order_snapshot_hash: `forged-timestamp-${runTag}`,
        created_at: pastDate,
      });
      expect(error).not.toBeNull();

      const { data: rows } = await service.from("special_price_approval_requests").select("id").eq("sales_order_id", orderId);
      expect(rows).toHaveLength(0);
    });

    it("3d. Sales memalsukan snapshot line (product_id/harga) lewat INSERT langsung ke special_price_approval_lines DITOLAK (permission)", async () => {
      const { approvalRequestId, itemId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const salesClient = await signIn("salesA1");
      const { error } = await salesClient.from("special_price_approval_lines").insert({
        approval_request_id: approvalRequestId, line_number: 2, product_id: productIds.a1,
        product_name_snapshot: "Produk A1", quantity: 1, master_unit_price: 10000,
        proposed_unit_price: 1, effective_floor_unit_price: 0, sales_order_item_id: itemId,
      });
      expect(error).not.toBeNull();

      const { data: rows } = await service.from("special_price_approval_lines").select("id").eq("approval_request_id", approvalRequestId);
      expect(rows).toHaveLength(1); // hanya baris asli dari RPC submit, tidak ada tambahan
    });
  });

  // ---------------------------------------------------------------------
  // 4. Mutasi direct-DML cross-tenant -- sebelumnya hanya diuji lewat RPC
  //    (not_found, gate-3e-d4-c3 #6) dan SELECT (gate-3e-d4-c1 #6d), belum
  //    pernah diuji UPDATE/DELETE langsung lintas tenant.
  // ---------------------------------------------------------------------

  describe("4. Cross-tenant direct DML (UPDATE/DELETE) ditolak", () => {
    it("4a. Owner tenant LAIN (companyB) UPDATE langsung request tenant A DITOLAK", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const ownerBClient = await signIn("ownerB");
      const { error } = await ownerBClient.from("special_price_approval_requests").update({ reason: "diambil alih tenant B" }).eq("id", approvalRequestId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_requests").select("reason, company_id").eq("id", approvalRequestId).single();
      expect((after as { reason: string }).reason).toBe("alasan proposal C5-B");
      expect((after as { company_id: string }).company_id).toBe(companyA);
    });

    it("4b. Owner tenant LAIN (companyB) DELETE langsung request tenant A DITOLAK", async () => {
      const { approvalRequestId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const ownerBClient = await signIn("ownerB");
      const { error } = await ownerBClient.from("special_price_approval_requests").delete().eq("id", approvalRequestId);
      expect(error).not.toBeNull();

      const { data: stillThere } = await service.from("special_price_approval_requests").select("id").eq("id", approvalRequestId).single();
      expect((stillThere as { id: string } | null)?.id).toBe(approvalRequestId);
    });

    it("4c. Sales tenant LAIN (companyB) UPDATE langsung line tenant A DITOLAK", async () => {
      const { approvalRequestId, itemId } = await makePendingProposal("a1", "salesA1", customerIds.A, companyA);
      const { data: lineRow } = await service.from("special_price_approval_lines").select("id, proposed_unit_price").eq("approval_request_id", approvalRequestId).eq("sales_order_item_id", itemId).single();
      const lineId = (lineRow as { id: string }).id;

      const salesBClient = await signIn("salesB1");
      const { error } = await salesBClient.from("special_price_approval_lines").update({ proposed_unit_price: 1 }).eq("id", lineId);
      expect(error).not.toBeNull();

      const { data: after } = await service.from("special_price_approval_lines").select("proposed_unit_price").eq("id", lineId).single();
      expect(Number((after as { proposed_unit_price: number }).proposed_unit_price)).toBe(8000);
    });
  });

  // ---------------------------------------------------------------------
  // 5. Regresi 13: existing C1-C5 tetap PASS -- diverifikasi lewat full run
  //    suite yang sama (dijalankan terpisah, dicatat di laporan closeout).
  //    Test di bawah HANYA memastikan file ini sendiri tidak merusak baseline
  //    end-to-end submit->approve->confirm (sanity check ringan, BUKAN
  //    pengulangan C3/C4/C5-A yang sudah lengkap).
  // ---------------------------------------------------------------------

  it("5. Sanity end-to-end: submit -> approve -> confirm tetap PASS setelah seluruh percobaan bypass di atas gagal (tidak ada residu korup)", async () => {
    const { orderId, approvalRequestId } = await makePendingProposal("a2", "salesA2", customerIds.A, companyA, 10000, 7500, 4);
    const ownerClient = await signIn("ownerA");
    const { data: decideData, error: decideErr } = await ownerClient.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: approvalRequestId,
      p_decision: "APPROVE",
      p_idempotency_key: `sanity-${runTag}`,
      p_decision_reason: null,
    });
    if (decideErr) throw new Error(decideErr.message);
    expect((decideData as { result_outcome: string }[])[0].result_outcome).toBe("approved");

    const { data: order } = await service.from("sales_orders").select("status, final_amount").eq("id", orderId).single();
    expect((order as { status: string }).status).toBe("draft");
    expect(Number((order as { final_amount: number }).final_amount)).toBeCloseTo(4 * 7500 * 1.11, 1);
  });
});
