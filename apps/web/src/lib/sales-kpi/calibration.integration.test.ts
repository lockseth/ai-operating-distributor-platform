// =============================================================================
// DB-backed integration test -- Sales KPI Owner Setup & Target Calibration.
//
// Membuktikan set_sales_kpi_targets_calibrated (migration 20260806000001)
// benar terhadap Postgres nyata: EC<=Call, target non-negatif (>=0, termasuk
// EC=0), versioning, LOCKED period, dan actor authorization/tenant
// isolation -- semua ditegakkan di level RPC (SECURITY DEFINER), tidak bisa
// dilewati dari TypeScript. Mock/InMemory tidak menegakkan CHECK constraint
// Postgres, jadi tidak bisa membuktikan relaksasi target_value >=0 (lihat
// migration -- ALTER TABLE ... DROP/ADD CONSTRAINT).
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia atau URL bukan
// loopback -- pola identik dengan achievement.integration.test.ts.
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

describeIfDb("set_sales_kpi_targets_calibrated RPC (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let otherOwnerAuthId = "";
  let periodId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const salesRoleId = (salesRole as { id: string }).id;

    const { data: ownerAuth } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner@verify.test`, password: randomUUID(), email_confirm: true,
    });
    ownerAuthId = ownerAuth!.user!.id;
    const { data: salesAuth } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@verify.test`, password: randomUUID(), email_confirm: true,
    });
    salesAuthId = salesAuth!.user!.id;
    const { data: otherOwnerAuth } = await supabase.auth.admin.createUser({
      email: `${runTag}-other-owner@verify.test`, password: randomUUID(), email_confirm: true,
    });
    otherOwnerAuthId = otherOwnerAuth!.user!.id;

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify Calib Co ${runTag}`, slug: `verify-calib-${runTag}` },
      { id: otherCompanyId, name: `Verify Calib Co Other ${runTag}`, slug: `verify-calib-other-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: otherOwnerAuthId, company_id: otherCompanyId, email: `${runTag}-other-owner@verify.test`, full_name: "Other Owner", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: otherOwnerAuthId, company_id: otherCompanyId, role_id: ownerRoleId },
    ]);

    await supabase.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId,
      p_name: `Kalibrasi ${runTag}`, p_start_date: "2026-08-01", p_end_date: "2026-08-31", p_working_days: 21,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_targets").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("sales_kpi_periods").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("sales_kpi_definitions").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, otherOwnerAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, otherCompanyId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    if (otherOwnerAuthId) await supabase.auth.admin.deleteUser(otherOwnerAuthId);
  }, 30000);

  it("EC > Call ditolak (ec_exceeds_call), tidak ada baris dibuat", async () => {
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 10, p_ec_target: 15, p_change_reason: "Target awal",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("ec_exceeds_call");
    const { count } = await supabase.from("sales_kpi_targets").select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("salesperson_id", salesAuthId);
    expect(count ?? 0).toBe(0);
  });

  it("target EC=0 sah (non-negatif), Call=0 juga sah", async () => {
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 10, p_ec_target: 0, p_change_reason: "Target awal, EC belum diperkirakan",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("saved");
    expect((data ?? [])[0]?.ec_outcome).toBe("created");
  });

  it("versioning: perubahan target membuat versi baru, tidak menimpa histori", async () => {
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 12, p_ec_target: 5, p_change_reason: "Revisi berdasarkan baseline",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("saved");
    expect((data ?? [])[0]?.call_version).toBe(2);

    const { data: history } = await supabase
      .from("sales_kpi_targets")
      .select("version, status, target_value")
      .eq("company_id", companyId).eq("salesperson_id", salesAuthId)
      .order("version");
    const rows = (history ?? []) as { version: number; status: string; target_value: number }[];
    expect(rows.filter((r) => r.status === "SUPERSEDED").length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => r.status === "ACTIVE").length).toBe(2);
  });

  it("Salesman (non-manager) ditolak forbidden", async () => {
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 20, p_ec_target: 10, p_change_reason: "Salesman coba ubah target sendiri",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("Owner tenant lain (cross-tenant) ditolak forbidden", async () => {
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: otherOwnerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 20, p_ec_target: 10, p_change_reason: "Owner tenant lain coba ubah",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("Periode LOCKED menolak perubahan target", async () => {
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "LOCKED",
    });
    const { data } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_salesperson_id: salesAuthId,
      p_call_target: 30, p_ec_target: 15, p_change_reason: "Coba edit periode terkunci",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("period_locked");
  });
});
