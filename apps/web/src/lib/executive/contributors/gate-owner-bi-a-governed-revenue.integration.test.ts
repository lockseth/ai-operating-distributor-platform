// =============================================================================
// DB-backed integration test -- Gate Owner BI-A: Business Health "Pencapaian
// Omzet" dan narasi insight/action harus memakai persentase REVENUE governed
// (sales_kpi_*), bukan lagi pctRevenue/gapRevenue legacy dari sales_reports.
//
// Sebelum fix: flowsales.ts sudah menghitung pctRevenueGoverned dari ledger
// governed tapi komponen health & narasi tetap memakai pctRevenue self-report
// -- test ini menyengaja membuat kedua angka BERBEDA JAUH (governed 90% vs
// legacy 20%) supaya assert langsung membuktikan sumber mana yang benar-benar
// dipakai runtime, bukan hanya bahwa kode "menyebut" pctRevenueGoverned.
//
// flowsalesContributor.contribute() memanggil createClient() dari
// @/lib/supabase/server, yang bergantung pada next/headers::cookies() (hanya
// tersedia di dalam request context Next.js). Di-mock ke client service-role
// sungguhan (bukan next/headers) supaya contribute() berjalan nyata terhadap
// Postgres lokal tanpa perlu mensimulasikan session cookie -- test ini
// membuktikan logika pemilihan sumber data, bukan RLS (RLS untuk tabel-tabel
// ini sudah dibuktikan terpisah di security.test.ts masing-masing modul).
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback -- pola identik dengan integration test lain di
// repo ini.
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

describeIfDb("flowsalesContributor -- governed REVENUE di Business Health (Gate Owner BI-A, DB-backed)", () => {
  let service: SupabaseClient;
  const runTag = `itest-bi-a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let customerId = "";
  let periodId = "";

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

    await service.from("companies").insert({ id: companyId, name: `Verify BI-A ${runTag}`, slug: `verify-bi-a-${runTag}` });
    await service.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
    ]);

    customerId = randomUUID();
    await service.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify BI-A", is_active: true,
    });

    // ── Foundation + periode ACTIVE + target REVENUE governed = 1.000.000 ──
    await service.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await service.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode BI-A ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
    await service.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
    await service.rpc("set_sales_kpi_target", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_kpi_code: "REVENUE", p_target_value: 1_000_000, p_change_reason: "Target awal periode",
    });

    // ── Achievement REVENUE governed = 900.000 (90%) lewat jalur order-confirm asli ──
    const orderId = randomUUID();
    await service.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 900_000,
    });
    await service.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    // ── sales_reports legacy = 200.000/1.000.000 (20%) -- SENGAJA jauh berbeda dari governed (90%) ──
    await service.from("sales_reports").insert({
      company_id: companyId, salesperson_id: salesAuthId, report_date: new Date().toISOString().slice(0, 10),
      target_oa: 5, achieved_oa: 2, target_revenue: 1_000_000, achieved_revenue: 200_000, remaining_working_days: 10,
    });
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("sales_kpi_achievement_events").delete().eq("company_id", companyId);
    await service.from("sales_orders").delete().eq("company_id", companyId);
    await service.from("sales_reports").delete().eq("company_id", companyId);
    await service.from("sales_kpi_targets").delete().eq("company_id", companyId);
    await service.from("sales_kpi_periods").delete().eq("company_id", companyId);
    await service.from("sales_kpi_definitions").delete().eq("company_id", companyId);
    await service.from("customers").delete().eq("company_id", companyId);
    await service.from("user_roles").delete().eq("company_id", companyId);
    await service.from("users").delete().in("id", [ownerAuthId, salesAuthId]);
    await service.from("companies").delete().eq("id", companyId);
    if (ownerAuthId) await service.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await service.auth.admin.deleteUser(salesAuthId);
    vi.restoreAllMocks();
  }, 30000);

  it("Business Health 'Pencapaian Omzet' memakai persentase REVENUE governed (90%), bukan pctRevenue legacy (20%)", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const component = result.health.find((h) => h.key === "sales_achievement");
    expect(component).toBeDefined();
    expect(component!.score).toBe(90);
    expect(component!.reason).toContain("90%");
    expect(component!.reason).not.toContain("20%");
    expect(component!.reason).toContain("Rp900");
    expect(component!.reason).not.toContain("Rp200");
  });

  it("insight/action gap omzet memakai gap REVENUE governed, bukan gap self-report", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const insight = result.insights.find((i) => i.title.includes("Pencapaian omzet"));
    expect(insight).toBeDefined();
    expect(insight!.title).toContain("90%");
    expect(insight!.title).not.toContain("20%");
    // gap governed = 1.000.000 - 900.000 = 100.000 (bukan gap legacy 800.000).
    expect(insight!.narrative).toMatch(/100rb|Rp100/);

    const urgentAction = result.actions.find((a) => a.priority === "URGENT");
    expect(urgentAction).toBeUndefined(); // 90% -- "on track", bukan critical (<70%) seperti legacy 20% akan memicu.
  });

  it("KPI tile 'Omzet Order Periode KPI Aktif' dan health component tetap konsisten satu sama lain (satu sumber kebenaran)", async () => {
    const { flowsalesContributor } = await import("./flowsales");
    const result = await flowsalesContributor.contribute({ companyId });

    const healthComponent = result.health.find((h) => h.key === "sales_achievement");
    const kpiTile = result.kpis.find((k) => k.key === "achieved_revenue_month");
    expect(healthComponent!.reason).toContain("90%");
    expect(kpiTile!.trendLabel).toContain("90%");
  });
});
