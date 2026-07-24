// =============================================================================
// Payment Status Integrity Containment Gate -- static assertion atas migration
// 20260824000001_lock_paid_status_generic_mutation.sql. Pola sama seperti
// apps/web/src/lib/audit-log/security.test.ts: baca teks migration langsung,
// bukan menjalankan Postgres, supaya security posture (SECURITY DEFINER,
// search_path, REVOKE/GRANT) dan guard paid tetap terverifikasi meskipun
// integration test DB-backed di-skip (tidak ada Supabase lokal).
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260824000001_lock_paid_status_generic_mutation.sql",
  ),
  "utf8",
);

describe("Payment Status Integrity Containment -- migration 20260824000001", () => {
  it("hanya CREATE OR REPLACE FUNCTION, tidak membuat tabel/kolom baru (containment, bukan payment module)", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.update_sales_order_status_atomic");
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/ADD COLUMN/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.sales_orders\s+SET\s+status\s*=\s*'paid'/i);
  });

  it("signature RPC tidak berubah (4 parameter, RETURNS TABLE(result_outcome TEXT))", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.update_sales_order_status_atomic(\n  p_company_id UUID,\n  p_actor_id UUID,\n  p_order_id UUID,\n  p_new_status TEXT\n)"
    );
    expect(migration).toContain("RETURNS TABLE(result_outcome TEXT)");
  });

  it("SECURITY DEFINER dan search_path tetap dipertahankan", () => {
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public");
  });

  it("Guard A: p_new_status = 'paid' ditolak dengan outcome eksplisit, sebelum UPDATE/audit apa pun", () => {
    expect(migration).toMatch(/IF p_new_status = 'paid' THEN\s*\n\s*RETURN QUERY SELECT 'payment_workflow_required'::TEXT;/);
  });

  it("Guard B: status existing 'paid' ditolak (dibekukan dua arah), sebelum UPDATE/audit apa pun", () => {
    expect(migration).toMatch(/IF v_old_status = 'paid' THEN\s*\n\s*RETURN QUERY SELECT 'paid_locked'::TEXT;/);
  });

  it("kedua guard RETURN sebelum blok UPDATE sales_orders / INSERT audit_logs (rejected mutation tidak menulis apa pun)", () => {
    const guardAIndex = migration.indexOf("'payment_workflow_required'");
    const guardBIndex = migration.indexOf("'paid_locked'");
    const updateIndex = migration.indexOf("UPDATE public.sales_orders");
    const insertAuditIndex = migration.indexOf("INSERT INTO public.audit_logs");
    expect(guardAIndex).toBeGreaterThan(-1);
    expect(guardBIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(-1);
    expect(insertAuditIndex).toBeGreaterThan(-1);
    expect(guardAIndex).toBeLessThan(updateIndex);
    expect(guardBIndex).toBeLessThan(updateIndex);
    expect(guardAIndex).toBeLessThan(insertAuditIndex);
    expect(guardBIndex).toBeLessThan(insertAuditIndex);
  });

  it("validasi actor aktif + permission orders.update + company boundary tetap dipertahankan", () => {
    expect(migration).toContain("u.is_active = TRUE");
    expect(migration).toContain("p.name = 'orders.update'");
    expect(migration).toContain("AND u.company_id = p_company_id");
    expect(migration).toContain("WHERE id = p_order_id AND company_id = p_company_id");
  });

  it("REVOKE dari PUBLIC/anon/authenticated dan GRANT hanya ke service_role tetap dipertahankan", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)\n  FROM PUBLIC, anon, authenticated;"
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)\n  TO service_role;"
    );
  });
});
