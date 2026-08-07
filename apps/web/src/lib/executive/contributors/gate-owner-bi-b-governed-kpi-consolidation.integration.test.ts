// =============================================================================
// DB-backed integration test -- Gate Owner BI-B: Owner Dashboard (Executive
// Intelligence) mengonsolidasikan KELIMA KPI governed
// (CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE/NOO) dari ledger sales_kpi_* sebagai
// primary Owner performance source, dan legacy OA (sales_reports.target_oa/
// achieved_oa) TIDAK BOLEH memengaruhi hasil KPI utama (Business Health Score).
//
// flowsalesContributor.contribute() memanggil createClient() dari
// @/lib/supabase/server -- di-mock ke client service-role sungguhan (pola
// identik dengan gate-owner-bi-a-governed-revenue.integration.test.ts) supaya
// contribute() berjalan nyata terhadap Postgres lokal.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../../.env.local");
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

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

describeIfDb("flowsalesContributor -- konsolidasi 5 KPI governed di Owner Dashboard (Gate Owner BI-B, DB-backed)", () => {
  let service: SupabaseClient;
  const runTag = `itest-bi-b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Tenant A -- tenant utama yang diperiksa di semua assertion.
  const companyId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let customerId = "";
  let periodId = "";
  let callId = "";
  let orderId = "";

  // Tenant B -- hanya untuk membuktikan isolasi tenant (data BERBEDA, TIDAK
  // boleh bocor ke agregat Tenant A).
  const companyBId = randomUUID();
  let ownerBAuthId = "";
  let salesBAuthId = "";
  let customerBId = "";
  let periodBId = "";

  beforeAll(async () => {
    service = createSupabaseClient(env!.url, env!.serviceRoleKey);
    mockCreateClient.mockImplementation(async () => service);

    const { data: ownerRole } = await service.from("roles").select("id").eq("name", "owner").single();
    const { data: salesRole } = await service.from("roles").select("id").eq("name", "sales").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const salesRoleId = (salesRole as { id: string }).id;

    const mkUser = async (label: string) => {
      const { data, error } = await service.auth.admin.createUser({
        email: `${runTag}-${label}@verify.test`, password: randomUUID(), email_confirm: true,
      });
      if (error || !data.user) throw new Error(`gagal buat auth user ${label}: ${error?.message}`);
      return data.user.id;
    };

    ownerAuthId = await mkUser("owner");
    salesAuthId = await mkUser("sales");
    ownerBAuthId = await mkUser("owner-b");
    salesBAuthId = await mkUser("sales-b");

    await service.from("companies").insert([
      { id: companyId, name: `Verify BI-B ${runTag}`, slug: `verify-bi-b-${runTag}` },
      { id: companyBId, name: `Verify BI-B Co B ${runTag}`, slug: `verify-bi-b-b-${runTag}` },
    ]);
    await service.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: `${runTag}-owner-b@verify.test`, full_name: "Owner Verify B", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: ownerRoleId },
      { user_id: salesBAuthId, company_id: companyBId, role_id: salesRoleId },
    ]);

    customerId = randomUUID();
    await service.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify BI-B",
      assigned_sales_id: salesAuthId, is_active: true,
    });
    customerBId = randomUUID();
    await service.from("customers").insert({
      id: customerBId, company_id: companyBId, code: `C-B-${runTag}`, name: "Toko Verify BI-B Co B",
      assigned_sales_id: salesBAuthId, is_active: true,
    });

    // ── Tenant A: foundation + periode ACTIVE + target kelima KPI governed ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode BI-B ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
    await service.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
    for (const [kpiCode, targetValue] of [
      ["CALL", 10], ["EFFECTIVE_CALL", 8], ["ORDER_COUNT", 5], ["REVENUE", 1_000_000], ["NOO", 3],
    ] as const) {
      await service.rpc("set_sales_kpi_target", {
        p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
        p_kpi_code: kpiCode, p_target_value: targetValue, p_change_reason: "Target awal periode BI-B",
      });
    }

    // ── Tenant A: achievement lewat jalur asli (Call valid -> order FIELD_VISIT
    //    confirmed -> trigger mengkredit CALL, EFFECTIVE_CALL, ORDER_COUNT,
    //    REVENUE, NOO sekaligus untuk SATU customer/order) ──
    const { data: callRow } = await service.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-08-01", p_outcome_notes: "Kunjungan verifikasi Gate Owner BI-B",
      p_idempotency_key: `${runTag}-call-1`,
    });
    callId = (callRow ?? [])[0]?.result_call_id as string;

    orderId = randomUUID();
    await service.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false, final_amount: 900_000,
    });
    await service.rpc("link_sales_order_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_order_id: orderId, p_call_id: callId,
    });
    await service.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    // ── Tenant A: legacy OA self-report SENGAJA dibuat ekstrem (achieved_oa
    //    jauh melebihi target) -- kalau OA masih memengaruhi Business Health
    //    Score, skor akan melonjak tidak wajar dan test #4 akan gagal.
    await service.from("sales_reports").insert({
      company_id: companyId, salesperson_id: salesAuthId, report_date: new Date().toISOString().slice(0, 10),
      target_oa: 1, achieved_oa: 500, target_revenue: 1_000_000, achieved_revenue: 1, remaining_working_days: 10,
    });

    // ── Tenant B: periode + target + achievement BERBEDA dari Tenant A,
    //    murni untuk membuktikan agregat governed Tenant A tidak bocor. ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyBId, p_actor_id: ownerBAuthId });
    const { data: periodBRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_name: `Periode BI-B Co B ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodBId = (periodBRow ?? [])[0]?.result_period_id as string;
    await service.rpc("set_sales_kpi_period_status", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_period_id: periodBId, p_next_status: "ACTIVE",
    });
    await service.rpc("set_sales_kpi_target", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_period_id: periodBId, p_salesperson_id: salesBAuthId,
      p_kpi_code: "REVENUE", p_target_value: 50_000_000, p_change_reason: "Target Co B",
    });
    const orderBId = randomUUID();
    await service.from("sales_orders").insert({
      id: orderBId, company_id: companyBId, order_number: `SO-B-${runTag}`, customer_id: customerBId,
      sales_id: salesBAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 40_000_000,
    });
    await service.from("sales_orders").update({ status: "confirmed" }).eq("id", orderBId).eq("status", "draft");
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    for (const id of [companyId, companyBId]) {
      await service.from("sales_kpi_achievement_events").delete().eq("company_id", id);
      await service.from("sales_orders").delete().eq("company_id", id);
      await service.from("sales_calls").delete().eq("company_id", id);
      await service.from("sales_reports").delete().eq("company_id", id);
      await service.from("sales_kpi_targets").delete().eq("company_id", id);
      await service.from("sales_kpi_periods").delete().eq("company_id", id);
      await service.from("sales_kpi_definitions").delete().eq("company_id", id);
      await service.from("customers").delete().eq("company_id", id);
      await service.from("user_roles").delete().eq("company_id", id);
    }
    await service.from("users").delete().in("id", [ownerAuthId, salesAuthId, ownerBAuthId, salesBAuthId]);
    await service.from("companies").delete().in("id", [companyId, companyBId]);
    for (const id of [ownerAuthId, salesAuthId, ownerBAuthId, salesBAuthId]) {
      if (id) await service.auth.admin.deleteUser(id);
    }
    vi.restoreAllMocks();
  }, 30000);

  it("1. Owner dashboard membaca kelima tile KPI governed (CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE/NOO) dari ledger", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const byKey = Object.fromEntries(result.kpis.map((k) => [k.key, k]));
    expect(byKey.call_period?.value).toBe("1/10");
    expect(byKey.effective_call_period?.value).toBe("1/8");
    expect(byKey.order_count_period?.value).toBe("1/5");
    expect(byKey.noo_period?.value).toBe("1/3");
    expect(byKey.achieved_revenue_month?.value).toContain("900");
  });

  it("2. Revenue yang ditampilkan governed (900rb dari ledger), bukan sales_reports.achieved_revenue (1)", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const revenueTile = result.kpis.find((k) => k.key === "achieved_revenue_month");
    expect(revenueTile?.value).toMatch(/900/);
    expect(revenueTile?.value).not.toMatch(/^Rp1$/);
    // Ketiga tile "omzet" yang ada (Omzet Hari Ini, Omzet Periode KPI Aktif,
    // Gap Omzet) semuanya turunan REVENUE governed/momentum order -- TIDAK
    // ada tile Revenue kedua yang bersumber dari sales_reports (self-report).
    const revenueTiles = result.kpis.filter((k) => k.label.toLowerCase().includes("omzet"));
    expect(revenueTiles).toHaveLength(3);
    expect(revenueTiles.map((k) => k.key).sort()).toEqual(
      ["achieved_revenue_month", "gap_revenue", "revenue_today"].sort(),
    );
  });

  it("3. NOO bersumber dari governed KPI ledger (first confirmed order per customer), bukan OA self-report", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const nooTile = result.kpis.find((k) => k.key === "noo_period");
    expect(nooTile?.value).toBe("1/3");
    expect(nooTile?.subValue).toMatch(/pencapaian|belum ditetapkan/);
  });

  it("4. Legacy OA (achieved_oa=500 vs target=1, self-report ekstrem) TIDAK memengaruhi Business Health Score", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    expect(result.health.find((h) => h.key === "oa_achievement")).toBeUndefined();
    // Semua komponen health yang tersisa harus <= 100 -- kalau OA (500/1 =
    // 50000%) masih bocor ke health manapun, ini akan gagal.
    for (const component of result.health) {
      expect(component.score).toBeLessThanOrEqual(100);
    }

    const oaTile = result.kpis.find((k) => k.key === "oa_month");
    expect(oaTile?.label).toMatch(/legacy|self-report/i);
  });

  it("5. Tenant isolation: agregat governed Tenant A tidak bocor dari/ke Tenant B", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const resultA = await flowsalesContributor.contribute({ companyId });
    const resultB = await flowsalesContributor.contribute({ companyId: companyBId });

    const revenueA = resultA.kpis.find((k) => k.key === "achieved_revenue_month");
    const revenueB = resultB.kpis.find((k) => k.key === "achieved_revenue_month");
    expect(revenueA?.value).toMatch(/900/);
    expect(revenueB?.value).toMatch(/40/);
    expect(revenueA?.value).not.toBe(revenueB?.value);

    // Co B tidak pernah menetapkan target CALL/EFFECTIVE_CALL/ORDER_COUNT/NOO
    // -- tile-nya harus "Data belum cukup", bukan ikut nilai Tenant A.
    const callB = resultB.kpis.find((k) => k.key === "call_period");
    expect(callB?.value).toBe("Data belum cukup");
  });
});
