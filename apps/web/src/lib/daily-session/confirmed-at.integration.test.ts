// =============================================================================
// DB-backed integration test -- sales_orders.confirmed_at trigger (Blocker 2,
// migration 20260811000001). Membuktikan trg_sales_orders_set_confirmed_at
// benar-benar menyala di Postgres nyata: hanya diisi transisi PERTAMA KALI
// ke 'confirmed', immutable setelahnya, TIDAK diisi untuk historical order.
// Skip graceful jika Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { SupabaseTodayOrdersRepository } from "./orders";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
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

describeIfDb("sales_orders.confirmed_at trigger -- Blocker 2 (Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-confat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const customerId = randomUUID();
  let salesAuthId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const salesRoleId = (salesRole as { id: string }).id;

    const { data: salesAuth, error } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@verify.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (error || !salesAuth.user) throw new Error(`gagal buat auth user: ${error?.message}`);
    salesAuthId = salesAuth.user.id;

    await supabase.from("companies").insert({ id: companyId, name: `Verify Confirmed At Co ${runTag}`, slug: `verify-confat-${runTag}` });
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true });
    await supabase.from("user_roles").insert({ user_id: salesAuthId, company_id: companyId, role_id: salesRoleId });
    await supabase.from("customers").insert({ id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify", assigned_sales_id: salesAuthId, is_active: true });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("id", customerId);
    await supabase.from("user_roles").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("id", salesAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
  }, 30000);

  it("draft -> confirmed mengisi confirmed_at pertama kali", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-1`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false,
    });
    let { data: row } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    expect((row as { confirmed_at: string | null }).confirmed_at).toBeNull();

    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId);
    ({ data: row } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single());
    expect((row as { confirmed_at: string | null }).confirmed_at).not.toBeNull();
  });

  it("update setelah confirmed (field tidak terkait) -> confirmed_at TIDAK berubah", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-2`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "FIELD_VISIT", is_historical: false,
    });
    const { data: firstRow } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    const firstConfirmedAt = (firstRow as { confirmed_at: string }).confirmed_at;
    expect(firstConfirmedAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await supabase.from("sales_orders").update({ notes: "catatan diedit" }).eq("id", orderId);
    const { data: secondRow } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    expect((secondRow as { confirmed_at: string }).confirmed_at).toBe(firstConfirmedAt);
  });

  it("cancel/reversal (confirmed -> cancelled) tidak menghapus confirmed_at asal", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-3`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "FIELD_VISIT", is_historical: false,
    });
    const { data: firstRow } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    const firstConfirmedAt = (firstRow as { confirmed_at: string }).confirmed_at;

    await supabase.from("sales_orders").update({ status: "cancelled" }).eq("id", orderId);
    const { data: secondRow } = await supabase.from("sales_orders").select("confirmed_at, status").eq("id", orderId).single();
    expect((secondRow as { confirmed_at: string }).confirmed_at).toBe(firstConfirmedAt);
    expect((secondRow as { status: string }).status).toBe("cancelled");
  });

  it("historical order (is_historical=true) berstatus confirmed TIDAK diberi confirmed_at palsu", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-4`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "OTHER", is_historical: true,
    });
    const { data: row } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    expect((row as { confirmed_at: string | null }).confirmed_at).toBeNull();
  });

  it("remote confirmed order (CUSTOMER_WHATSAPP) tetap dapat confirmed_at, tapi tidak menjadi Call/EC (ORDER_COUNT/REVENUE tetap terkredit sejak Gate 3E-D0-F3)", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-5`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "CUSTOMER_WHATSAPP", is_historical: false,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId);

    const { data: row } = await supabase.from("sales_orders").select("confirmed_at, call_id").eq("id", orderId).single();
    expect((row as { confirmed_at: string | null }).confirmed_at).not.toBeNull();
    expect((row as { call_id: string | null }).call_id).toBeNull();

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, kpi_code")
      .eq("order_id", orderId);
    const rows = (events ?? []) as { id: string; kpi_code: string }[];
    expect(rows.filter((r) => r.kpi_code === "CALL" || r.kpi_code === "EFFECTIVE_CALL")).toHaveLength(0);
  });

  it("countConfirmedToday memakai confirmed_at, BUKAN created_at -- dibuat 'kemarin' (created_at dipaksa mundur) tapi confirmed hari ini tetap dihitung", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-6`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false,
    });
    // Paksa created_at mundur 2 hari -- membuktikan repository TIDAK
    // membaca created_at sama sekali untuk keputusan "confirmed hari ini".
    await supabase.from("sales_orders").update({ created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("id", orderId);
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId);

    const { data: row } = await supabase.from("sales_orders").select("confirmed_at").eq("id", orderId).single();
    const confirmedAtIso = (row as { confirmed_at: string }).confirmed_at;
    const businessDate = businessDateJakarta(new Date(confirmedAtIso));

    const repo = new SupabaseTodayOrdersRepository(supabase);
    const count = await repo.countConfirmedToday(companyId, salesAuthId, businessDate);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
