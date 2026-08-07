// =============================================================================
// DB-backed integration test -- Gate 3E-D5-C: KPI Foundation Initialization &
// Governed KPI Display Recovery.
//
// Diagnosis read-only sebelumnya (Gate 3E-D5-B-H-R1 diagnostic) menemukan:
// tenant tanpa sales_kpi_definitions tidak pernah bisa menyimpan target
// (foundation_not_initialized) karena initializeSalesKpiFoundationAction
// tidak pernah terhubung ke UI mana pun. Gate ini menambahkan jalur UI
// eksplisit ("Inisialisasi KPI") -- test ini membuktikan RPC/repository yang
// dipanggilnya (initialize_sales_kpi_foundation, migration
// 20261002000001 CREATE OR REPLACE) benar-benar idempotent, fail-closed, dan
// membawa deskripsi EFFECTIVE_CALL yang sudah tidak mewajibkan Sales Order.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// atau URL bukan loopback -- pola identik dengan integration test lain di
// direktori yang sama.
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

describeIfDb("Gate 3E-D5-C -- KPI foundation initialization (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-kpifound-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const companyBId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let ownerBAuthId = "";

  async function initialize(companyId: string, actorId: string) {
    const { data, error } = await supabase.rpc("initialize_sales_kpi_foundation", {
      p_company_id: companyId,
      p_actor_id: actorId,
    });
    if (error) throw error;
    return (data ?? [])[0] as { result_outcome: string; definition_count: number };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: roles } = await supabase.from("roles").select("id, name").in("name", ["owner", "sales"]);
    const roleId = (name: string) => (roles as { id: string; name: string }[]).find((r) => r.name === name)!.id;

    const mkUser = async (label: string) => {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `${runTag}-${label}@verify.test`, password: randomUUID(), email_confirm: true,
      });
      if (error || !data.user) throw new Error(`gagal buat auth user ${label}: ${error?.message}`);
      return data.user.id;
    };

    ownerAuthId = await mkUser("owner");
    salesAuthId = await mkUser("sales");
    ownerBAuthId = await mkUser("owner-b");

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify KpiFound Co ${runTag}`, slug: `verify-kpifound-${runTag}` },
      { id: companyBId, name: `Verify KpiFound Co B ${runTag}`, slug: `verify-kpifound-b-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: `${runTag}-owner-b@verify.test`, full_name: "Owner Verify B", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: roleId("owner") },
      { user_id: salesAuthId, company_id: companyId, role_id: roleId("sales") },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: roleId("owner") },
    ]);
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_definitions").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, ownerBAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, companyBId]);
    for (const id of [ownerAuthId, salesAuthId, ownerBAuthId]) {
      if (id) await supabase.auth.admin.deleteUser(id);
    }
  }, 30000);

  it("1&2. Tenant tanpa foundation dapat diinisialisasi melalui action sah -- lima definition muncul tepat sekali", async () => {
    const before = await supabase
      .from("sales_kpi_definitions")
      .select("code")
      .eq("company_id", companyId);
    expect(before.data ?? []).toHaveLength(0);

    const result = await initialize(companyId, ownerAuthId);
    expect(result.result_outcome).toBe("initialized");
    expect(result.definition_count).toBe(5);

    const { data: definitions } = await supabase
      .from("sales_kpi_definitions")
      .select("code")
      .eq("company_id", companyId)
      .is("superseded_at", null);
    const codes = ((definitions ?? []) as { code: string }[]).map((d) => d.code).sort();
    expect(codes).toEqual(["CALL", "EFFECTIVE_CALL", "NOO", "ORDER_COUNT", "REVENUE"]);
  });

  it("3. Retry initialization tidak membuat duplikat", async () => {
    const retry = await initialize(companyId, ownerAuthId);
    expect(retry.result_outcome).toBe("already_initialized");
    expect(retry.definition_count).toBe(5);

    const { data: definitions } = await supabase
      .from("sales_kpi_definitions")
      .select("id")
      .eq("company_id", companyId);
    expect(definitions ?? []).toHaveLength(5);
  });

  it("4. Authorization fail-closed: Sales tidak dapat menginisialisasi foundation", async () => {
    const result = await initialize(companyId, salesAuthId);
    expect(result.result_outcome).toBe("forbidden");
  });

  it("4. Tenant isolation: Owner tenant lain tidak dapat menginisialisasi tenant ini", async () => {
    const result = await initialize(companyId, ownerBAuthId);
    expect(result.result_outcome).toBe("forbidden");

    const { data: definitionsB } = await supabase
      .from("sales_kpi_definitions")
      .select("id")
      .eq("company_id", companyBId);
    expect(definitionsB ?? []).toHaveLength(0);
  });

  it("6. EC description menggunakan kontrak baru tanpa kewajiban order", async () => {
    const { data } = await supabase
      .from("sales_kpi_definitions")
      .select("description")
      .eq("company_id", companyId)
      .eq("code", "EFFECTIVE_CALL")
      .single();
    const description = (data as { description: string }).description;
    expect(description).toContain("tidak wajib");
    expect(description).not.toMatch(/^Call valid yang menghasilkan Sales Order confirmed/);
  });

  it("7. Saving CALL/EC target berhasil setelah initialization", async () => {
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode KpiFound ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    const periodId = (periodRow ?? [])[0]?.result_period_id as string;
    expect(periodId).toBeTruthy();

    const { data: targetRow, error } = await supabase.rpc("set_sales_kpi_targets_calibrated", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId,
      p_salesperson_id: salesAuthId, p_call_target: 15, p_ec_target: 15,
      p_change_reason: "Target awal periode",
    });
    expect(error).toBeNull();
    const row = (targetRow ?? [])[0] as { result_outcome: string };
    expect(row.result_outcome).toBe("saved");

    const { data: targets } = await supabase
      .from("sales_kpi_targets")
      .select("target_value, kpi_definition:sales_kpi_definitions(code)")
      .eq("company_id", companyId)
      .eq("period_id", periodId)
      .eq("salesperson_id", salesAuthId)
      .eq("status", "ACTIVE");
    const rows = (targets ?? []) as { target_value: number; kpi_definition: { code: string } | { code: string }[] | null }[];
    const byCode = new Map(rows.map((r) => {
      const def = Array.isArray(r.kpi_definition) ? r.kpi_definition[0] : r.kpi_definition;
      return [def?.code, r.target_value];
    }));
    expect(byCode.get("CALL")).toBe(15);
    expect(byCode.get("EFFECTIVE_CALL")).toBe(15);
  });

  it("8. Target pada tenant TANPA foundation mengembalikan foundation_not_initialized (bukan pesan generik tersamar)", async () => {
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_name: `Periode NoFoundation ${runTag}`,
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    const periodId = (periodRow ?? [])[0]?.result_period_id as string;

    const { data: salesBRow } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales-b@verify.test`, password: randomUUID(), email_confirm: true,
    });
    const salesBAuthId = salesBRow!.user!.id;
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    await supabase.from("users").insert({
      id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true,
    });
    await supabase.from("user_roles").insert({
      user_id: salesBAuthId, company_id: companyBId, role_id: (salesRole as { id: string }).id,
    });

    const { data: targetRow } = await supabase.rpc("set_sales_kpi_target", {
      p_company_id: companyBId, p_actor_id: ownerBAuthId, p_period_id: periodId,
      p_salesperson_id: salesBAuthId, p_kpi_code: "CALL", p_target_value: 10,
      p_change_reason: "Percobaan tanpa foundation",
    });
    const row = (targetRow ?? [])[0] as { result_outcome: string };
    expect(row.result_outcome).toBe("foundation_not_initialized");

    await supabase.from("user_roles").delete().eq("user_id", salesBAuthId);
    await supabase.from("users").delete().eq("id", salesBAuthId);
    await supabase.auth.admin.deleteUser(salesBAuthId);
  });
});
