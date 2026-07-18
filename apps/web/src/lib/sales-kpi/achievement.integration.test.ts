// =============================================================================
// DB-backed integration test -- Sales KPI Achievement Integration.
//
// Skenario 7-10, 14, dan 17 (crediting/reversal Effective Call otomatis lewat
// trigger sales_orders, cap satu-EC-per-Call, dan pengecualian legacy import)
// TIDAK BISA dibuktikan lewat InMemory/mock -- logic-nya sengaja hidup
// sebagai trigger PostgreSQL (credit_effective_call_for_order,
// reverse_effective_call_for_order), bukan kode TypeScript, supaya berlaku
// untuk SEMUA jalur yang mengubah sales_orders.status (confirm di
// repository.ts, resolusi dispute, koreksi admin) tanpa duplikasi logic.
// Hanya Postgres sungguhan yang bisa membuktikan trigger ini benar-benar
// menyala pada urutan operasi yang tepat.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak
// tersedia, ATAU kalau URL yang terbaca BUKAN loopback -- pola identik
// dengan commit-invalid-status.integration.test.ts (lihat file itu untuk
// detail SAFETY GUARD isLoopbackSupabaseUrl()).
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

describeIfDb("Sales KPI Achievement Integration -- EC crediting/reversal (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
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

    await supabase.from("companies").insert({ id: companyId, name: `Verify KPI Co ${runTag}`, slug: `verify-kpi-${runTag}` });
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
    ]);
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify",
      assigned_sales_id: salesAuthId, is_active: true,
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_achievement_events").delete().eq("company_id", companyId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("sales_calls").delete().eq("company_id", companyId);
    await supabase.from("sales_call_tasks").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("id", customerId);
    await supabase.from("user_roles").delete().eq("company_id", companyId);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId]);
    await supabase.from("companies").delete().eq("id", companyId);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
  }, 30000);

  it("7. Confirmed order linked ke Call valid menghasilkan satu EC", async () => {
    const { data: callRow } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-01", p_outcome_notes: "Kunjungan verifikasi EC",
      p_idempotency_key: `${runTag}-call-1`,
    });
    const callId = (callRow ?? [])[0]?.result_call_id as string;
    expect(callId).toBeTruthy();

    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-1`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false,
    });
    const { data: linkRow } = await supabase.rpc("link_sales_order_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_order_id: orderId, p_call_id: callId,
    });
    expect((linkRow ?? [])[0]?.result_outcome).toBe("linked");

    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type")
      .eq("call_id", callId);
    const rows = (events ?? []) as { kpi_code: string; event_type: string }[];
    expect(rows.filter((r) => r.kpi_code === "CALL" && r.event_type === "CREDITED")).toHaveLength(1);
    expect(rows.filter((r) => r.kpi_code === "EFFECTIVE_CALL" && r.event_type === "CREDITED")).toHaveLength(1);
  });

  it("8-9. Order kedua pada Call yang sama & retry confirmation tidak menggandakan EC", async () => {
    const { data: callRow } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-02", p_outcome_notes: "Kunjungan uji cap EC",
      p_idempotency_key: `${runTag}-call-2`,
    });
    const callId = (callRow ?? [])[0]?.result_call_id as string;

    const orderId1 = randomUUID();
    const orderId2 = randomUUID();
    await supabase.from("sales_orders").insert([
      { id: orderId1, company_id: companyId, order_number: `SO-${runTag}-2a`, customer_id: customerId, sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false },
      { id: orderId2, company_id: companyId, order_number: `SO-${runTag}-2b`, customer_id: customerId, sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false },
    ]);
    await supabase.rpc("link_sales_order_call", { p_company_id: companyId, p_actor_id: salesAuthId, p_order_id: orderId1, p_call_id: callId });
    await supabase.rpc("link_sales_order_call", { p_company_id: companyId, p_actor_id: salesAuthId, p_order_id: orderId2, p_call_id: callId });

    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId1).eq("status", "draft");
    // retry confirm (no-op transition since already confirmed)
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId1).eq("status", "draft");
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId2).eq("status", "draft");

    const { data: ecEvents } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("call_id", callId).eq("kpi_code", "EFFECTIVE_CALL").eq("event_type", "CREDITED");
    expect(ecEvents ?? []).toHaveLength(1);
  });

  it("10. Remote/unlinked confirmed order tidak menghasilkan Call maupun EC", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-remote`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "CUSTOMER_WHATSAPP", is_historical: false,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("order_id", orderId);
    expect(events ?? []).toHaveLength(0);
  });

  it("14. Dispute/cancellation menyatakan order tidak sah -> EC reversal append-only, event asal tetap ada", async () => {
    const { data: callRow } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-03", p_outcome_notes: "Kunjungan uji reversal",
      p_idempotency_key: `${runTag}-call-3`,
    });
    const callId = (callRow ?? [])[0]?.result_call_id as string;

    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-3`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false,
    });
    await supabase.rpc("link_sales_order_call", { p_company_id: companyId, p_actor_id: salesAuthId, p_order_id: orderId, p_call_id: callId });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    // resolusi dispute/cancellation menyatakan order tidak sah -> status cancelled
    await supabase.from("sales_orders").update({ status: "cancelled" }).eq("id", orderId);

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("event_type")
      .eq("call_id", callId).eq("kpi_code", "EFFECTIVE_CALL");
    const rows = (events ?? []) as { event_type: string }[];
    expect(rows.filter((r) => r.event_type === "CREDITED")).toHaveLength(1);
    expect(rows.filter((r) => r.event_type === "REVERSED")).toHaveLength(1);

    // retry cancel (no-op, status sudah cancelled) -- tidak reversal ganda
    await supabase.from("sales_orders").update({ status: "cancelled" }).eq("id", orderId).neq("status", "cancelled");
    const { data: eventsAfterRetry } = await supabase
      .from("sales_kpi_achievement_events")
      .select("event_type")
      .eq("call_id", callId).eq("kpi_code", "EFFECTIVE_CALL").eq("event_type", "REVERSED");
    expect(eventsAfterRetry ?? []).toHaveLength(1);
  });

  it("17. Legacy import (is_historical=TRUE) tidak pernah menghasilkan achievement meski linked + FIELD_VISIT + confirmed", async () => {
    const { data: callRow } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-04", p_outcome_notes: "Kunjungan untuk uji legacy",
      p_idempotency_key: `${runTag}-call-4`,
    });
    const callId = (callRow ?? [])[0]?.result_call_id as string;

    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-legacy`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "FIELD_VISIT", is_historical: true, call_id: callId,
    });

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("order_id", orderId);
    expect(events ?? []).toHaveLength(0);
  });

  it("Append-only enforcement: UPDATE/DELETE pada ledger ditolak DB, langsung sebagai superuser sekalipun", async () => {
    const { data: anyEvent } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .limit(1)
      .single();
    const eventId = (anyEvent as { id: string } | null)?.id;
    expect(eventId).toBeTruthy();

    const { error: updateError } = await supabase
      .from("sales_kpi_achievement_events")
      .update({ reversal_reason: "hack" })
      .eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("sales_kpi_achievement_events")
      .delete()
      .eq("id", eventId);
    expect(deleteError).not.toBeNull();
  });

  it("out_of_coverage & duplicate_same_day ditegakkan di RPC sungguhan (bukan hanya TypeScript)", async () => {
    const outOfCoverageCustomerId = randomUUID();
    await supabase.from("customers").insert({
      id: outOfCoverageCustomerId, company_id: companyId, code: `C-OOC-${runTag}`, name: "Toko Luar Wilayah",
      is_active: true,
    });
    const { data: rejected } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: outOfCoverageCustomerId, p_call_date: "2026-08-05", p_outcome_notes: "Coba luar wilayah",
      p_idempotency_key: `${runTag}-ooc-1`,
    });
    expect((rejected ?? [])[0]?.result_outcome).toBe("out_of_coverage");

    await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-06", p_outcome_notes: "Kunjungan pertama hari itu",
      p_idempotency_key: `${runTag}-dup-1`,
    });
    const { data: dup } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-06", p_outcome_notes: "Kunjungan kedua tanpa task",
      p_idempotency_key: `${runTag}-dup-2`,
    });
    expect((dup ?? [])[0]?.result_outcome).toBe("duplicate_same_day");

    await supabase.from("customers").delete().eq("id", outOfCoverageCustomerId);
  });
});
