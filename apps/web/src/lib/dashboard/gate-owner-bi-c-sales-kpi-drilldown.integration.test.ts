// =============================================================================
// DB-backed integration test -- Gate Owner BI-C: drill-down "Performa Sales"
// per salesperson di Owner Dashboard memakai KELIMA KPI governed
// (CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE/NOO) dari ledger sales_kpi_* pada
// periode ACTIVE -- BUKAN lagi sales_reports (self-report OA/omzet harian).
//
// getOwnerSalesKpiPerformance() memanggil createClient() dari
// @/lib/supabase/server -- di-mock ke client service-role sungguhan (pola
// identik dengan gate-owner-bi-b-governed-kpi-consolidation.integration.test.ts)
// supaya query berjalan nyata terhadap Postgres lokal.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
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

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

describeIfDb("getOwnerSalesKpiPerformance -- drill-down governed per salesperson (Gate Owner BI-C, DB-backed)", () => {
  let service: SupabaseClient;
  const runTag = `itest-bi-c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Tenant A -- dua salesperson, dipakai untuk membuktikan grouping per-orang
  // + ranking governed + OA legacy tidak berpengaruh.
  const companyId = randomUUID();
  let ownerAuthId = "";
  let sales1AuthId = "";
  let sales2AuthId = "";
  let customer1Id = "";
  let customer2Id = "";
  let periodId = "";

  // Tenant B -- isolasi tenant.
  const companyBId = randomUUID();
  let ownerBAuthId = "";
  let salesBAuthId = "";
  let customerBId = "";

  // Tenant C -- periode dibuat tapi TIDAK diaktifkan (tetap DRAFT), untuk
  // membuktikan semantik ACTIVE-only.
  const companyCId = randomUUID();
  let ownerCAuthId = "";
  let salesCAuthId = "";
  let periodCId = "";

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
    sales1AuthId = await mkUser("sales1");
    sales2AuthId = await mkUser("sales2");
    ownerBAuthId = await mkUser("owner-b");
    salesBAuthId = await mkUser("sales-b");
    ownerCAuthId = await mkUser("owner-c");
    salesCAuthId = await mkUser("sales-c");

    await service.from("companies").insert([
      { id: companyId, name: `Verify BI-C ${runTag}`, slug: `verify-bi-c-${runTag}` },
      { id: companyBId, name: `Verify BI-C Co B ${runTag}`, slug: `verify-bi-c-b-${runTag}` },
      { id: companyCId, name: `Verify BI-C Co C ${runTag}`, slug: `verify-bi-c-c-${runTag}` },
    ]);
    await service.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: sales1AuthId, company_id: companyId, email: `${runTag}-sales1@verify.test`, full_name: "Sales Satu", is_active: true },
      { id: sales2AuthId, company_id: companyId, email: `${runTag}-sales2@verify.test`, full_name: "Sales Dua", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: `${runTag}-owner-b@verify.test`, full_name: "Owner Verify B", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true },
      { id: ownerCAuthId, company_id: companyCId, email: `${runTag}-owner-c@verify.test`, full_name: "Owner Verify C", is_active: true },
      { id: salesCAuthId, company_id: companyCId, email: `${runTag}-sales-c@verify.test`, full_name: "Sales Verify C", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: sales1AuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: sales2AuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: ownerRoleId },
      { user_id: salesBAuthId, company_id: companyBId, role_id: salesRoleId },
      { user_id: ownerCAuthId, company_id: companyCId, role_id: ownerRoleId },
      { user_id: salesCAuthId, company_id: companyCId, role_id: salesRoleId },
    ]);

    customer1Id = randomUUID();
    customer2Id = randomUUID();
    await service.from("customers").insert([
      { id: customer1Id, company_id: companyId, code: `C1-${runTag}`, name: "Toko Satu", assigned_sales_id: sales1AuthId, is_active: true },
      { id: customer2Id, company_id: companyId, code: `C2-${runTag}`, name: "Toko Dua", assigned_sales_id: sales2AuthId, is_active: true },
    ]);
    customerBId = randomUUID();
    await service.from("customers").insert({
      id: customerBId, company_id: companyBId, code: `C-B-${runTag}`, name: "Toko Verify BI-C Co B",
      assigned_sales_id: salesBAuthId, is_active: true,
    });

    // ── Tenant A: foundation + periode ACTIVE + target kelima KPI governed
    //    untuk KEDUA salesperson (target Sales 2 sengaja lebih besar) ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode BI-C ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
    await service.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
    for (const [salespersonId, kpiCode, targetValue] of [
      [sales1AuthId, "CALL", 10], [sales1AuthId, "EFFECTIVE_CALL", 8], [sales1AuthId, "ORDER_COUNT", 5],
      [sales1AuthId, "REVENUE", 1_000_000], [sales1AuthId, "NOO", 3],
      [sales2AuthId, "CALL", 20], [sales2AuthId, "EFFECTIVE_CALL", 15], [sales2AuthId, "ORDER_COUNT", 10],
      [sales2AuthId, "REVENUE", 2_000_000], [sales2AuthId, "NOO", 5],
    ] as const) {
      await service.rpc("set_sales_kpi_target", {
        p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salespersonId,
        p_kpi_code: kpiCode, p_target_value: targetValue, p_change_reason: "Target awal periode BI-C",
      });
    }

    // ── Achievement Sales 1: 1 Call valid -> 1 order FIELD_VISIT confirmed
    //    (final_amount 900rb, DI BAWAH target REVENUE) ──
    const { data: call1Row } = await service.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: sales1AuthId, p_salesperson_id: sales1AuthId,
      p_customer_id: customer1Id, p_call_date: "2026-08-01", p_outcome_notes: "Kunjungan verifikasi BI-C sales 1",
      p_idempotency_key: `${runTag}-call-1`,
    });
    const call1Id = (call1Row ?? [])[0]?.result_call_id as string;
    const order1Id = randomUUID();
    await service.from("sales_orders").insert({
      id: order1Id, company_id: companyId, order_number: `SO1-${runTag}`, customer_id: customer1Id,
      sales_id: sales1AuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false, final_amount: 900_000,
    });
    await service.rpc("link_sales_order_call", {
      p_company_id: companyId, p_actor_id: sales1AuthId, p_order_id: order1Id, p_call_id: call1Id,
    });
    await service.from("sales_orders").update({ status: "confirmed" }).eq("id", order1Id).eq("status", "draft");

    // ── Achievement Sales 2: 1 Call valid -> 1 order FIELD_VISIT confirmed
    //    (final_amount 2.5jt, DI ATAS target REVENUE -- Sales 2 harus ranking
    //    #1 governed meskipun Sales 1 nanti dibuat "menang" di sales_reports) ──
    const { data: call2Row } = await service.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: sales2AuthId, p_salesperson_id: sales2AuthId,
      p_customer_id: customer2Id, p_call_date: "2026-08-01", p_outcome_notes: "Kunjungan verifikasi BI-C sales 2",
      p_idempotency_key: `${runTag}-call-2`,
    });
    const call2Id = (call2Row ?? [])[0]?.result_call_id as string;
    const order2Id = randomUUID();
    await service.from("sales_orders").insert({
      id: order2Id, company_id: companyId, order_number: `SO2-${runTag}`, customer_id: customer2Id,
      sales_id: sales2AuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false, final_amount: 2_500_000,
    });
    await service.rpc("link_sales_order_call", {
      p_company_id: companyId, p_actor_id: sales2AuthId, p_order_id: order2Id, p_call_id: call2Id,
    });
    await service.from("sales_orders").update({ status: "confirmed" }).eq("id", order2Id).eq("status", "draft");

    // ── Legacy sales_reports Sales 1: dibuat EKSTREM (achieved_revenue jauh
    //    lebih tinggi dari Sales 2) supaya kalau governed drill-down masih
    //    membaca sales_reports, ranking akan terbalik dan test akan gagal. ──
    await service.from("sales_reports").insert({
      company_id: companyId, salesperson_id: sales1AuthId, report_date: new Date().toISOString().slice(0, 10),
      target_oa: 1, achieved_oa: 500, target_revenue: 1_000_000, achieved_revenue: 99_000_000, remaining_working_days: 10,
    });

    // ── Tenant B: periode + target + achievement BERBEDA, untuk isolasi ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyBId, p_actor_id: ownerBAuthId });
    const { data: periodBRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_name: `Periode BI-C Co B ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    const periodBId = (periodBRow ?? [])[0]?.result_period_id as string;
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

    // ── Tenant C: periode dibuat TAPI TIDAK diaktifkan (tetap DRAFT) --
    //    target sengaja tetap diset di periode DRAFT ini untuk membuktikan
    //    drill-down TIDAK membacanya selama periode belum ACTIVE. ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyCId, p_actor_id: ownerCAuthId });
    const { data: periodCRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyCId, p_actor_id: ownerCAuthId, p_name: `Periode BI-C Co C ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodCId = (periodCRow ?? [])[0]?.result_period_id as string;
    await service.rpc("set_sales_kpi_target", {
      p_company_id: companyCId, p_actor_id: ownerCAuthId, p_period_id: periodCId, p_salesperson_id: salesCAuthId,
      p_kpi_code: "REVENUE", p_target_value: 10_000_000, p_change_reason: "Target Co C (periode belum aktif)",
    });
  }, 90000);

  afterAll(async () => {
    if (!service) return;
    for (const id of [companyId, companyBId, companyCId]) {
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
    await service.from("users").delete().in("id", [
      ownerAuthId, sales1AuthId, sales2AuthId, ownerBAuthId, salesBAuthId, ownerCAuthId, salesCAuthId,
    ]);
    await service.from("companies").delete().in("id", [companyId, companyBId, companyCId]);
    for (const id of [ownerAuthId, sales1AuthId, sales2AuthId, ownerBAuthId, salesBAuthId, ownerCAuthId, salesCAuthId]) {
      if (id) await service.auth.admin.deleteUser(id);
    }
    vi.restoreAllMocks();
  }, 30000);

  it("1. Membaca governed KPI ledger, bukan sales_reports -- kelima kode KPI direpresentasikan benar per salesperson", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const result = await getOwnerSalesKpiPerformance(companyId);

    expect(result.periodActive).toBe(true);
    expect(result.rows).toHaveLength(2);

    const row1 = result.rows.find((r) => r.salespersonId === sales1AuthId)!;
    expect(row1.call).toMatchObject({ target: 10, actual: 1 });
    expect(row1.effectiveCall).toMatchObject({ target: 8, actual: 1 });
    expect(row1.orderCount).toMatchObject({ target: 5, actual: 1 });
    expect(row1.revenue).toMatchObject({ target: 1_000_000, actual: 900_000 });
    expect(row1.noo).toMatchObject({ target: 3, actual: 1 });
  });

  it("2. Divergent sales_reports (achieved_revenue 99jt self-report) TIDAK menggantikan REVENUE governed (900rb)", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const result = await getOwnerSalesKpiPerformance(companyId);

    const row1 = result.rows.find((r) => r.salespersonId === sales1AuthId)!;
    expect(row1.revenue.actual).toBe(900_000);
    expect(row1.revenue.actual).not.toBe(99_000_000);
  });

  it("3. Legacy OA (sales_reports.achieved_oa=500) tidak muncul dan tidak memengaruhi ranking governed", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const result = await getOwnerSalesKpiPerformance(companyId);

    // Tidak ada field OA sama sekali di baris governed.
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("oa");
      expect(row).not.toHaveProperty("achieved_oa");
    }
    // Ranking governed (REVENUE actual descending) -- Sales 2 (2.5jt) harus
    // #1, BUKAN Sales 1 meskipun sales_reports Sales 1 dibuat ekstrem.
    expect(result.rows[0].salespersonId).toBe(sales2AuthId);
    expect(result.rows[1].salespersonId).toBe(sales1AuthId);
  });

  it("4. Salesperson A tidak pernah menerima achievement milik salesperson B (grouping benar)", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const result = await getOwnerSalesKpiPerformance(companyId);

    const row1 = result.rows.find((r) => r.salespersonId === sales1AuthId)!;
    const row2 = result.rows.find((r) => r.salespersonId === sales2AuthId)!;

    expect(row1.revenue.target).toBe(1_000_000);
    expect(row1.revenue.actual).toBe(900_000);
    expect(row2.revenue.target).toBe(2_000_000);
    expect(row2.revenue.actual).toBe(2_500_000);
    expect(row1.revenue.actual).not.toBe(row2.revenue.actual);
    expect(row1.call.target).toBe(10);
    expect(row2.call.target).toBe(20);
  });

  it("5. Tenant isolation: drill-down Tenant A tidak bocor dari/ke Tenant B", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const resultA = await getOwnerSalesKpiPerformance(companyId);
    const resultB = await getOwnerSalesKpiPerformance(companyBId);

    expect(resultA.rows.some((r) => r.salespersonId === salesBAuthId)).toBe(false);
    expect(resultB.rows.some((r) => r.salespersonId === sales1AuthId || r.salespersonId === sales2AuthId)).toBe(false);

    const rowB = resultB.rows.find((r) => r.salespersonId === salesBAuthId)!;
    expect(rowB.revenue.actual).toBe(40_000_000);
    // Co B tidak pernah menetapkan target CALL -- harus DATA_INSUFFICIENT (null), bukan ikut Tenant A.
    expect(rowB.call.target).toBeNull();
    expect(rowB.call.pacingStatus).toBe("DATA_INSUFFICIENT");
  });

  it("6. Semantik periode ACTIVE: target di periode DRAFT (Tenant C) TIDAK terbaca sampai diaktifkan", async () => {
    const { getOwnerSalesKpiPerformance } = await import("./owner-sales-kpi-performance");
    const resultC = await getOwnerSalesKpiPerformance(companyCId);

    expect(resultC.periodActive).toBe(false);
    expect(resultC.periodName).toBeNull();
    const rowC = resultC.rows.find((r) => r.salespersonId === salesCAuthId)!;
    // Target REVENUE 10jt sudah diset di periode DRAFT, tapi tidak boleh terbaca.
    expect(rowC.revenue.target).toBeNull();
    expect(rowC.revenue.pacingStatus).toBe("DATA_INSUFFICIENT");

    await service.rpc("set_sales_kpi_period_status", {
      p_company_id: companyCId, p_actor_id: ownerCAuthId, p_period_id: periodCId, p_next_status: "ACTIVE",
    });
    const resultCActive = await getOwnerSalesKpiPerformance(companyCId);
    expect(resultCActive.periodActive).toBe(true);
    const rowCActive = resultCActive.rows.find((r) => r.salespersonId === salesCAuthId)!;
    expect(rowCActive.revenue.target).toBe(10_000_000);
  });
});
