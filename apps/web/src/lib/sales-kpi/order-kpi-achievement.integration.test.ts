// =============================================================================
// DB-backed integration test -- Gate 3E-D0-F3 Unified Governed KPI & Telegram
// Order Credit (ORDER_COUNT + REVENUE).
//
// Sama seperti achievement.integration.test.ts: logic kredit/reversal
// ORDER_COUNT/REVENUE hidup sebagai trigger PostgreSQL
// (credit_order_kpi_for_sales_order, reverse_order_kpi_for_sales_order),
// BUKAN kode TypeScript, supaya berlaku untuk SEMUA channel/order_source
// yang mengubah sales_orders.status lewat sales_orders (confirm di
// repository.ts, resolusi dispute, invoice-void cancellation, koreksi admin)
// tanpa Telegram-specific KPI truth. Hanya Postgres sungguhan yang bisa
// membuktikan ini.
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

describeIfDb("Gate 3E-D0-F3 -- ORDER_COUNT/REVENUE crediting & reversal (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-okpi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const companyBId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let salesBAuthId = "";
  const customerId = randomUUID();

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

    const { data: salesBAuth, error: salesBErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales-b@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (salesBErr || !salesBAuth.user) throw new Error(`gagal buat auth user sales B: ${salesBErr?.message}`);
    salesBAuthId = salesBAuth.user.id;

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify OrderKPI Co ${runTag}`, slug: `verify-okpi-${runTag}` },
      { id: companyBId, name: `Verify OrderKPI Co B ${runTag}`, slug: `verify-okpi-b-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: salesBAuthId, company_id: companyBId, role_id: salesRoleId },
    ]);
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify",
      assigned_sales_id: salesAuthId, is_active: true,
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_achievement_events").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_targets").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_periods").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_definitions").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_orders").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("customers").delete().eq("id", customerId);
    await supabase.from("user_roles").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, salesBAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, companyBId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    if (salesBAuthId) await supabase.auth.admin.deleteUser(salesBAuthId);
  }, 30000);

  it("1. Owner dapat menetapkan target ORDER_COUNT dan REVENUE per Sales/periode lewat RPC sungguhan", async () => {
    await supabase.rpc("initialize_sales_kpi_foundation", {
      p_company_id: companyId, p_actor_id: ownerAuthId,
    });

    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode ${runTag}`,
      p_start_date: "2026-09-01", p_end_date: "2026-09-30", p_working_days: 22,
    });
    const periodId = (periodRow ?? [])[0]?.result_period_id as string;
    expect(periodId).toBeTruthy();
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });

    const { data: orderCountResult } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "ORDER_COUNT", p_target_value: 30,
      p_change_reason: "Target awal ORDER_COUNT",
    });
    expect((orderCountResult ?? [])[0]?.result_outcome).toBe("created");

    const { data: revenueResult } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_kpi_code: "REVENUE", p_target_value: 50_000_000,
      p_change_reason: "Target awal REVENUE",
    });
    expect((revenueResult ?? [])[0]?.result_outcome).toBe("created");
  });

  it("2-3. Confirmed order (remote/Telegram, bukan FIELD_VISIT) mengkredit tepat 1 ORDER_COUNT + REVENUE exact; retry status update tidak menggandakan", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-okpi-1`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "CUSTOMER_WHATSAPP", source_channel: "telegram",
      is_historical: false, final_amount: 1_250_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");
    // retry (mensimulasikan retry webhook Telegram/update_id ganda) -- no-op transition
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId);

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, value")
      .eq("order_id", orderId);
    const rows = (events ?? []) as { kpi_code: string; event_type: string; value: string | number }[];

    const orderCountCredits = rows.filter((r) => r.kpi_code === "ORDER_COUNT" && r.event_type === "CREDITED");
    const revenueCredits = rows.filter((r) => r.kpi_code === "REVENUE" && r.event_type === "CREDITED");
    expect(orderCountCredits).toHaveLength(1);
    expect(Number(orderCountCredits[0].value)).toBe(1);
    expect(revenueCredits).toHaveLength(1);
    expect(Number(revenueCredits[0].value)).toBe(1_250_000);

    // 4. Order remote (order_source != FIELD_VISIT, tanpa call_id) TIDAK PERNAH mengkredit EFFECTIVE_CALL.
    const ecCredits = rows.filter((r) => r.kpi_code === "EFFECTIVE_CALL");
    expect(ecCredits).toHaveLength(0);
  });

  it("5. Cancellation/reversal order confirmed menghasilkan REVERSED yang benar (event asal tetap ada, append-only)", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-okpi-2`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "CUSTOMER_PHONE", is_historical: false,
      final_amount: 800_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");
    await supabase.from("sales_orders").update({ status: "cancelled" }).eq("id", orderId);

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, value")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });
    const rows = (events ?? []) as { kpi_code: string; event_type: string; value: string | number }[];

    for (const code of ["ORDER_COUNT", "REVENUE"]) {
      const credited = rows.filter((r) => r.kpi_code === code && r.event_type === "CREDITED");
      const reversed = rows.filter((r) => r.kpi_code === code && r.event_type === "REVERSED");
      expect(credited).toHaveLength(1);
      expect(reversed).toHaveLength(1);
      expect(Number(reversed[0].value)).toBe(Number(credited[0].value));
    }

    // retry cancel (no-op, status sudah cancelled) -- tidak reversal ganda
    await supabase.from("sales_orders").update({ status: "cancelled" }).eq("id", orderId).neq("status", "cancelled");
    const { data: eventsAfterRetry } = await supabase
      .from("sales_kpi_achievement_events")
      .select("event_type")
      .eq("order_id", orderId).eq("kpi_code", "REVENUE").eq("event_type", "REVERSED");
    expect(eventsAfterRetry ?? []).toHaveLength(1);
  });

  it("Order tanpa sales_id tidak mengkredit siapa pun (tidak ada orphan credit)", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-orphan`, customer_id: customerId,
      sales_id: null, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 500_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("order_id", orderId);
    expect(events ?? []).toHaveLength(0);
  });

  it("Legacy import (is_historical=TRUE) tidak pernah mengkredit ORDER_COUNT/REVENUE meski confirmed", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-legacy-okpi`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "OTHER", is_historical: true, final_amount: 900_000,
    });

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("order_id", orderId);
    expect(events ?? []).toHaveLength(0);
  });

  it("6. Cross-tenant: order company B tidak pernah mengkredit ledger company A, dan sebaliknya", async () => {
    const customerBId = randomUUID();
    await supabase.from("customers").insert({
      id: customerBId, company_id: companyBId, code: `C-B-${runTag}`, name: "Toko Verify B",
      assigned_sales_id: salesBAuthId, is_active: true,
    });
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyBId, order_number: `SO-${runTag}-tenantB`, customer_id: customerBId,
      sales_id: salesBAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 2_000_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: eventsB } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, company_id")
      .eq("order_id", orderId);
    const rowsB = (eventsB ?? []) as { id: string; company_id: string }[];
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r) => r.company_id === companyBId)).toBe(true);

    const { data: leakedIntoA } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("order_id", orderId);
    expect(leakedIntoA ?? []).toHaveLength(0);

    await supabase.from("sales_orders").delete().eq("id", orderId);
    await supabase.from("customers").delete().eq("id", customerBId);
  });

  it("6. Cross-sales: target/achievement RPC company A tidak dapat dipakai untuk salesperson company B (fail-closed)", async () => {
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode Cross ${runTag}`,
      p_start_date: "2026-10-01", p_end_date: "2026-10-31", p_working_days: 22,
    });
    const periodId = (periodRow ?? [])[0]?.result_period_id as string;
    expect(periodId).toBeTruthy();

    const { data: crossResult } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesBAuthId, p_kpi_code: "ORDER_COUNT", p_target_value: 10,
      p_change_reason: "Percobaan lintas tenant",
    });
    expect((crossResult ?? [])[0]?.result_outcome).toBe("salesperson_not_eligible");
  });

  it("Append-only enforcement tetap berlaku untuk baris ORDER_COUNT/REVENUE, langsung sebagai superuser sekalipun", async () => {
    const { data: anyEvent } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "REVENUE")
      .limit(1)
      .single();
    const eventId = (anyEvent as { id: string } | null)?.id;
    expect(eventId).toBeTruthy();

    const { error: updateError } = await supabase
      .from("sales_kpi_achievement_events")
      .update({ value: 999999 })
      .eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("sales_kpi_achievement_events")
      .delete()
      .eq("id", eventId);
    expect(deleteError).not.toBeNull();
  });
});
