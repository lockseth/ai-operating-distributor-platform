import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const actions = readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
const service = readFileSync(path.resolve(__dirname, "service.ts"), "utf8");
const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260804000001_configurable_sales_kpi_foundation.sql",
  ),
  "utf8",
);

describe("Configurable Sales KPI security contracts", () => {
  it("semua tabel foundation memiliki company_id, RLS, dan authenticated SELECT-only", () => {
    for (const table of [
      "sales_kpi_definitions",
      "sales_kpi_periods",
      "sales_kpi_targets",
    ]) {
      const tableStart = migration.indexOf(
        `CREATE TABLE IF NOT EXISTS public.${table}`,
      );
      const tableBody = migration.slice(
        tableStart,
        migration.indexOf(";", tableStart),
      );
      expect(tableStart).toBeGreaterThan(-1);
      expect(tableBody).toContain("company_id");
      expect(migration).toContain(`ALTER TABLE public.${table}`);
      expect(migration).toContain("ENABLE ROW LEVEL SECURITY");
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated`,
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT SELECT ON TABLE public\\.${table}\\s+TO authenticated`,
        ),
      );
      expect(migration).not.toContain(
        `GRANT INSERT ON TABLE public.${table} TO authenticated`,
      );
      expect(migration).not.toContain(
        `GRANT UPDATE ON TABLE public.${table} TO authenticated`,
      );
      expect(migration).not.toContain(
        `GRANT DELETE ON TABLE public.${table} TO authenticated`,
      );
    }
  });

  it("Salesman hanya dapat membaca target sendiri melalui RLS", () => {
    const policyStart = migration.indexOf(
      'CREATE POLICY "sales_kpi_targets_select"',
    );
    const policy = migration.slice(
      policyStart,
      migration.indexOf(";", policyStart),
    );
    expect(policy).toContain("company_id = public.get_user_company_id()");
    expect(policy).toContain("salesperson_id = auth.uid()");
    expect(policy).toContain("'owner','manager','super_admin'");
    expect(policy).not.toContain("'admin'");
  });

  it("semua mutation RPC SECURITY DEFINER memiliki fixed search_path", () => {
    for (const fn of [
      "initialize_sales_kpi_foundation",
      "create_sales_kpi_period",
      "set_sales_kpi_period_status",
      "set_sales_kpi_target",
    ]) {
      const start = migration.indexOf(
        `CREATE OR REPLACE FUNCTION public.${fn}`,
      );
      const body = migration.slice(start, migration.indexOf("$$;", start));
      expect(start).toBeGreaterThan(-1);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path = pg_catalog, public");
      expect(body).toContain("u.company_id = p_company_id");
      expect(body).toContain("r.name IN ('owner','manager','super_admin')");
    }
  });

  it("RPC tidak dapat dipanggil PUBLIC, anon, atau authenticated", () => {
    for (const fn of [
      "initialize_sales_kpi_foundation(UUID, UUID)",
      "create_sales_kpi_period(UUID, UUID, TEXT, DATE, DATE, INTEGER)",
      "set_sales_kpi_period_status(UUID, UUID, UUID, TEXT)",
      "set_sales_kpi_target(UUID, UUID, UUID, UUID, TEXT, INTEGER, TEXT)",
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      const revokeStart = migration.indexOf(
        `REVOKE ALL ON FUNCTION public.${fn}`,
      );
      expect(migration.slice(revokeStart, revokeStart + 180)).toContain(
        "FROM PUBLIC, anon, authenticated",
      );
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
    }
  });

  it("initializer dan target RPC fail-closed pada CALL/EFFECTIVE_CALL saja", () => {
    expect(migration).toContain("p_kpi_code NOT IN ('CALL','EFFECTIVE_CALL')");
    expect(migration).toContain("'ar_is_kpi', FALSE");
    expect(migration).toContain("'weighted_score_enabled', FALSE");
    expect(migration).not.toContain("'AR_COLLECTION'");
    expect(service).toContain("SALES_KPI_CODES");
    // REVENUE diizinkan sejak Gate 3E-D0-F3 (governed order-based KPI) --
    // AR/COLLECTION tetap dilarang (bukan KPI, lihat lock decision #2).
    expect(service).not.toMatch(/code:\s*["'](?:AR|COLLECTION)/);
  });

  it("target wajib salesman aktif pada tenant yang sama", () => {
    const start = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.set_sales_kpi_target",
    );
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("u.id = p_salesperson_id");
    expect(body).toContain("u.company_id = p_company_id");
    expect(body).toContain("u.is_active = TRUE");
    expect(body).toContain("r.name = 'sales'");
    expect(body).toContain("'salesperson_not_eligible'");
  });

  it("target versioning mempertahankan history dan locked period menolak perubahan", () => {
    expect(migration).toContain("previous_target_id");
    expect(migration).toContain("status = 'SUPERSEDED', superseded_at = NOW()");
    expect(migration).toContain("IF v_period_status = 'LOCKED'");
    expect(migration).toContain("'period_locked'");
    expect(migration).toContain("'sales_kpi.target_revised'");
  });

  it("Server Actions authenticate dan authorize sebelum membuat admin client", () => {
    for (const fn of [
      "initializeSalesKpiFoundationAction",
      "createSalesKpiPeriodAction",
      "setSalesKpiPeriodStatusAction",
      "setSalesKpiTargetAction",
    ]) {
      const start = actions.indexOf(`export async function ${fn}`);
      const body = actions.slice(start, start + 1400);
      expect(start).toBeGreaterThan(-1);
      expect(body).toContain("getAuthorizedContext()");
      expect(body.indexOf("getAuthorizedContext()")).toBeLessThan(
        body.indexOf("getAdminClient()"),
      );
    }
    expect(actions).toContain("user.isDemo");
    expect(actions).toContain('"sales_kpi.manage"');
  });

  it("form input tidak menerima companyId, actorId, role, atau permission", () => {
    for (const shape of [
      "CreateSalesKpiPeriodFormInput",
      "SetSalesKpiTargetFormInput",
    ]) {
      const start = actions.indexOf(`export interface ${shape}`);
      const end = actions.indexOf("}", start);
      const body = actions.slice(start, end);
      expect(body).not.toMatch(/companyId|actorId|\brole\b|permission/);
    }
    expect(actions).toContain("companyId: context.user.company_id");
    expect(actions).toContain("actorId: context.user.id");
  });

  it("phase foundation tidak membuat achievement measurement atau weighted score table", () => {
    expect(migration).not.toMatch(
      /CREATE TABLE IF NOT EXISTS public\.(?:sales_)?kpi_(?:measurements|achievements|scores)/,
    );
    expect(migration).not.toMatch(/weight\s+(?:INTEGER|NUMERIC|DECIMAL)/i);
    expect(migration).toContain(
      "Achievement measurements are intentionally outside this foundation phase",
    );
  });
});
