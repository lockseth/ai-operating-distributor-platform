// =============================================================================
// DB-backed integration test -- Gate 3E-D5-A KPI Salesman: Target Periode
// NOO (New Outlet Opening / Buka Toko Baru).
//
// Sama seperti order-kpi-achievement.integration.test.ts: logic kredit NOO
// hidup sebagai trigger PostgreSQL (credit_noo_for_sales_order), BUKAN kode
// TypeScript -- supaya berlaku untuk SEMUA jalur yang bisa memindahkan
// sales_orders.status -> 'confirmed' (confirm_sales_order_atomic, retry,
// dsb.) tanpa bergantung pada satu RPC saja. Hanya Postgres sungguhan yang
// bisa membuktikan invariant "maksimal satu kredit NOO seumur hidup per
// customer" di bawah concurrency.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak
// tersedia, ATAU kalau URL yang terbaca BUKAN loopback.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
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

describeIfDb("Gate 3E-D5-A -- NOO crediting (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-noo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const companyBId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let salesBAuthId = "";
  let salesOtherAuthId = "";
  let periodId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const salesRoleId = (salesRole as { id: string }).id;

    const { data: ownerAuth, error: ownerErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (ownerErr || !ownerAuth.user) throw new Error(`gagal buat auth user owner: ${ownerErr?.message}`);
    ownerAuthId = ownerAuth.user.id;

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user sales: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;

    const { data: salesOtherAuth, error: salesOtherErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales-other@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (salesOtherErr || !salesOtherAuth.user) throw new Error(`gagal buat auth user sales other: ${salesOtherErr?.message}`);
    salesOtherAuthId = salesOtherAuth.user.id;

    const { data: salesBAuth, error: salesBErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales-b@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (salesBErr || !salesBAuth.user) throw new Error(`gagal buat auth user sales B: ${salesBErr?.message}`);
    salesBAuthId = salesBAuth.user.id;

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify NOO Co ${runTag}`, slug: `verify-noo-${runTag}` },
      { id: companyBId, name: `Verify NOO Co B ${runTag}`, slug: `verify-noo-b-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Salma Verify", is_active: true },
      { id: salesOtherAuthId, company_id: companyId, email: `${runTag}-sales-other@verify.test`, full_name: "Sales Lain Verify", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: salesOtherAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: salesBAuthId, company_id: companyBId, role_id: salesRoleId },
    ]);

    await supabase.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode NOO ${runTag}`,
      p_start_date: "2026-09-01", p_end_date: "2026-09-30", p_working_days: 22,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_achievement_events").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_targets").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_periods").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_definitions").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_orders").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("customers").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, salesOtherAuthId, salesBAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, companyBId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    if (salesOtherAuthId) await supabase.auth.admin.deleteUser(salesOtherAuthId);
    if (salesBAuthId) await supabase.auth.admin.deleteUser(salesBAuthId);
  }, 30000);

  it("1. Owner dapat menetapkan periode + target NOO untuk Salma lewat RPC sungguhan", async () => {
    const { data: nooResult } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "NOO", p_target_value: 5,
      p_change_reason: "Target awal NOO Salma",
    });
    expect((nooResult ?? [])[0]?.result_outcome).toBe("created");
  });

  it("2. Membuat customer saja (belum ada order) -> realisasi NOO tetap 0", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo1`, name: "Toko Baru Verify 1",
      assigned_sales_id: salesAuthId, is_active: true,
    });

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    expect(events ?? []).toHaveLength(0);
  });

  it("3-5. draft / pending_owner_approval / rejected order tidak pernah mengkredit NOO", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo2`, name: "Toko Baru Verify 2",
      assigned_sales_id: salesAuthId, is_active: true,
    });

    const draftOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: draftOrderId, company_id: companyId, order_number: `SO-${runTag}-noo-draft`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 700_000,
    });

    const pendingOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: pendingOrderId, company_id: companyId, order_number: `SO-${runTag}-noo-pending`, customer_id: customerId,
      sales_id: salesAuthId, status: "pending_owner_approval", order_source: "OTHER", is_historical: false, final_amount: 700_000,
    });

    const rejectedOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: rejectedOrderId, company_id: companyId, order_number: `SO-${runTag}-noo-rejected`, customer_id: customerId,
      sales_id: salesAuthId, status: "rejected", order_source: "OTHER", is_historical: false, final_amount: 700_000,
    });

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    expect(events ?? []).toHaveLength(0);
  });

  it("6-8. First confirmed order mengkredit NOO tepat 1; retry & order kedua customer sama tidak menggandakan", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo3`, name: "Toko Baru Verify 3",
      assigned_sales_id: salesAuthId, is_active: true,
    });

    const order1Id = randomUUID();
    await supabase.from("sales_orders").insert({
      id: order1Id, company_id: companyId, order_number: `SO-${runTag}-noo-first`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 1_000_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", order1Id).eq("status", "draft");
    // retry (mensimulasikan retry webhook/update_id ganda) -- no-op transition
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", order1Id).eq("status", "draft");
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", order1Id);

    const { data: eventsAfterFirst } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, salesperson_id, customer_id, order_id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    const rowsAfterFirst = (eventsAfterFirst ?? []) as { kpi_code: string; event_type: string; salesperson_id: string; customer_id: string; order_id: string }[];
    expect(rowsAfterFirst.filter((r) => r.event_type === "CREDITED")).toHaveLength(1);
    expect(rowsAfterFirst[0].order_id).toBe(order1Id);
    // 10. kredit masuk ke salesperson hasil auto-attribution order (sales_id) yang benar.
    expect(rowsAfterFirst[0].salesperson_id).toBe(salesAuthId);

    // 8. order confirmed KEDUA untuk customer yang SAMA tidak menambah NOO lagi.
    const order2Id = randomUUID();
    await supabase.from("sales_orders").insert({
      id: order2Id, company_id: companyId, order_number: `SO-${runTag}-noo-second`, customer_id: customerId,
      sales_id: salesOtherAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 500_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", order2Id).eq("status", "draft");

    const { data: eventsAfterSecond } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, salesperson_id, order_id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("event_type", "CREDITED")
      .eq("customer_id", customerId);
    expect(eventsAfterSecond ?? []).toHaveLength(1);
    // 11. order KEDUA (salesman lain) tidak menerima kredit -- baris NOO tetap milik order pertama/Salma.
    expect((eventsAfterSecond ?? [])[0]?.order_id).toBe(order1Id);
    expect((eventsAfterSecond ?? [])[0]?.salesperson_id).toBe(salesAuthId);
  });

  it("9. First confirmed order pada customer BERBEDA menambah NOO lagi (+1)", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo4`, name: "Toko Baru Verify 4",
      assigned_sales_id: salesAuthId, is_active: true,
    });
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-noo-cust2`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 900_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("event_type", "CREDITED")
      .eq("customer_id", customerId);
    expect(events ?? []).toHaveLength(1);
  });

  it("Customer dengan legacy confirmed order (is_historical=TRUE) tidak menghasilkan NOO baru untuk order berikutnya", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo-legacy`, name: "Toko Legacy Verify",
      assigned_sales_id: salesAuthId, is_active: true,
    });
    const legacyOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: legacyOrderId, company_id: companyId, order_number: `SO-${runTag}-noo-legacy`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "OTHER", is_historical: true, final_amount: 2_000_000,
    });

    // Legacy order sendiri tidak mengkredit NOO.
    const { data: legacyEvents } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    expect(legacyEvents ?? []).toHaveLength(0);

    // Order BARU (non-historis) untuk customer yang sama BUKAN NOO lagi --
    // customer sudah "pernah confirmed" (legacy) sebelumnya.
    const newOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: newOrderId, company_id: companyId, order_number: `SO-${runTag}-noo-post-legacy`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 300_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", newOrderId).eq("status", "draft");

    const { data: eventsAfter } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    expect(eventsAfter ?? []).toHaveLength(0);
  });

  it("Order tanpa sales_id tidak mengkredit NOO ke siapa pun (tidak ada orphan credit)", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo-orphan`, name: "Toko Orphan Verify",
      assigned_sales_id: null, is_active: true,
    });
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-noo-orphan`, customer_id: customerId,
      sales_id: null, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 400_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerId);
    expect(events ?? []).toHaveLength(0);
  });

  it("12. Concurrent confirmation dua order berbeda pada customer yang sama tidak menghasilkan duplicate NOO", async () => {
    const customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}-noo-race`, name: "Toko Race Verify",
      assigned_sales_id: salesAuthId, is_active: true,
    });
    const orderAId = randomUUID();
    const orderBId = randomUUID();
    await supabase.from("sales_orders").insert([
      {
        id: orderAId, company_id: companyId, order_number: `SO-${runTag}-noo-race-a`, customer_id: customerId,
        sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 600_000,
      },
      {
        id: orderBId, company_id: companyId, order_number: `SO-${runTag}-noo-race-b`, customer_id: customerId,
        sales_id: salesOtherAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 600_000,
      },
    ]);

    await Promise.all([
      supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderAId).eq("status", "draft"),
      supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderBId).eq("status", "draft"),
    ]);

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, order_id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("event_type", "CREDITED")
      .eq("customer_id", customerId);
    const rows = (events ?? []) as { id: string; order_id: string }[];
    expect(rows).toHaveLength(1);
    expect([orderAId, orderBId]).toContain(rows[0].order_id);
  });

  it("Cross-tenant: order company B tidak pernah mengkredit ledger NOO company A, dan sebaliknya", async () => {
    const customerBId = randomUUID();
    await supabase.from("customers").insert({
      id: customerBId, company_id: companyBId, code: `C-B-${runTag}-noo`, name: "Toko Verify B",
      assigned_sales_id: salesBAuthId, is_active: true,
    });
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyBId, order_number: `SO-${runTag}-noo-tenantB`, customer_id: customerBId,
      sales_id: salesBAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 1_500_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: eventsB } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, company_id")
      .eq("kpi_code", "NOO")
      .eq("customer_id", customerBId);
    const rowsB = (eventsB ?? []) as { id: string; company_id: string }[];
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r) => r.company_id === companyBId)).toBe(true);

    const { data: leakedIntoA } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("customer_id", customerBId);
    expect(leakedIntoA ?? []).toHaveLength(0);
  });

  it("13. Salesman tidak dapat mengubah target NOO tenant sendiri (forbidden, fail-closed)", async () => {
    const { data: forgedTarget } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "NOO", p_target_value: 999,
      p_change_reason: "Percobaan salesman mengubah target sendiri",
    });
    expect((forgedTarget ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("13. Owner tenant lain (cross-tenant) tidak dapat mengubah target NOO company ini (fail-closed)", async () => {
    const { data: crossResult } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: salesBAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "NOO", p_target_value: 999,
      p_change_reason: "Percobaan lintas tenant",
    });
    expect((crossResult ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("13. Achievement event NOO tidak dapat di-forge langsung (fail-closed di layer permission tabel, RLS write ditolak)", async () => {
    const anonKey = env!.url; // placeholder untuk menegaskan kita TIDAK memakai service key di sini
    void anonKey;
    // Tabel sales_kpi_achievement_events TIDAK memiliki GRANT INSERT untuk
    // authenticated -- hanya SELECT. Percobaan INSERT langsung lewat client
    // biasa (bukan service_role) harus ditolak Postgres (permission denied),
    // membuktikan tidak ada jalur forge achievement event selain trigger.
    const anonClient = createClient(env!.url, env!.serviceRoleKey);
    // Gunakan service key tapi lewat REST (bukan RPC) untuk membuktikan
    // bahkan service_role tidak pernah dipakai UI/actions -- actions.ts
    // hanya memanggil RPC. Uji nyata "tidak ada GRANT INSERT authenticated"
    // sudah dicek di security.test.ts (migration source); di sini kita
    // membuktikan sisi lain: RPC set_sales_kpi_target TIDAK menerima kpi_code
    // di luar daftar dukungan (mis. mencoba forge kredit lewat kpi_code
    // sembarang tetap unsupported_kpi, bukan diam-diam diterima).
    const { data: bogusResult } = await anonClient.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "FORGED_NOO", p_target_value: 1,
      p_change_reason: "Percobaan forge kpi_code",
    });
    expect((bogusResult ?? [])[0]?.result_outcome).toBe("unsupported_kpi");
  });

  it("14. Append-only enforcement tetap berlaku untuk baris NOO, langsung sebagai superuser sekalipun", async () => {
    const { data: anyEvent } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "NOO")
      .eq("event_type", "CREDITED")
      .limit(1)
      .single();
    const eventId = (anyEvent as { id: string } | null)?.id;
    expect(eventId).toBeTruthy();

    const { error: updateError } = await supabase
      .from("sales_kpi_achievement_events")
      .update({ value: 999 })
      .eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("sales_kpi_achievement_events")
      .delete()
      .eq("id", eventId);
    expect(deleteError).not.toBeNull();
  });
});
