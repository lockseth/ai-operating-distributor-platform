// =============================================================================
// Invoiced Status Integrity Containment Gate -- static assertion atas migration
// 20260825000001_lock_invoiced_status_generic_mutation.sql. Pola sama seperti
// status-lock-migration.security.test.ts (paid): baca teks migration
// langsung, bukan menjalankan Postgres, supaya security posture (SECURITY
// DEFINER, search_path, REVOKE/GRANT) dan guard invoiced+paid tetap
// terverifikasi meskipun integration test DB-backed di-skip (tidak ada
// Supabase lokal).
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260825000001_lock_invoiced_status_generic_mutation.sql",
  ),
  "utf8",
);

describe("Invoiced Status Integrity Containment -- migration 20260825000001", () => {
  it("hanya CREATE OR REPLACE FUNCTION, tidak membuat tabel/kolom baru, tidak backfill (containment, bukan Document Engine/receivable ledger)", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.update_sales_order_status_atomic");
    expect(migration).not.toMatch(/CREATE TABLE/i);
    expect(migration).not.toMatch(/ADD COLUMN/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.sales_orders\s+SET\s+status\s*=\s*'invoiced'/i);
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

  it("Guard C: p_new_status = 'invoiced' ditolak dengan outcome eksplisit, sebelum UPDATE/audit apa pun", () => {
    expect(migration).toMatch(/IF p_new_status = 'invoiced' THEN\s*\n\s*RETURN QUERY SELECT 'invoice_issuance_required'::TEXT;/);
  });

  it("Guard D: status existing 'invoiced' ditolak (dibekukan dua arah, termasuk keluar ke paid), sebelum UPDATE/audit apa pun", () => {
    expect(migration).toMatch(/IF v_old_status = 'invoiced' THEN\s*\n\s*RETURN QUERY SELECT 'invoiced_locked'::TEXT;/);
  });

  it("guard paid (A/B) existing tetap utuh -- containment sebelumnya tidak diregresi", () => {
    expect(migration).toMatch(/IF v_old_status = 'paid' THEN\s*\n\s*RETURN QUERY SELECT 'paid_locked'::TEXT;/);
    expect(migration).toMatch(/IF p_new_status = 'paid' THEN\s*\n\s*RETURN QUERY SELECT 'payment_workflow_required'::TEXT;/);
  });

  it("Guard D (invoiced_locked) dicek SEBELUM Guard C (payment_workflow_required) -- invoiced -> paid ditolak sebagai invoiced_locked, bukan tercampur semantik payment", () => {
    const invoicedLockedIndex = migration.indexOf("'invoiced_locked'");
    const paymentWorkflowIndex = migration.indexOf("'payment_workflow_required'");
    expect(invoicedLockedIndex).toBeGreaterThan(-1);
    expect(paymentWorkflowIndex).toBeGreaterThan(-1);
    expect(invoicedLockedIndex).toBeLessThan(paymentWorkflowIndex);
  });

  it("keempat guard (A/B/C/D) RETURN sebelum blok UPDATE sales_orders / INSERT audit_logs (rejected mutation tidak menulis apa pun)", () => {
    const guardIndexes = [
      migration.indexOf("'invoiced_locked'"),
      migration.indexOf("'paid_locked'"),
      migration.indexOf("'invoice_issuance_required'"),
      migration.indexOf("'payment_workflow_required'"),
    ];
    const updateIndex = migration.indexOf("UPDATE public.sales_orders");
    const insertAuditIndex = migration.indexOf("INSERT INTO public.audit_logs");
    for (const idx of guardIndexes) {
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(updateIndex);
      expect(idx).toBeLessThan(insertAuditIndex);
    }
  });

  it("sync_sales_order_delivery_status (jalur auto-derived delivery) tidak di-CREATE OR REPLACE/diubah migration ini -- referensi nama fungsi di komentar penjelas tetap boleh ada", () => {
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION public.sync_sales_order_delivery_status");
    expect(migration).not.toMatch(/ALTER FUNCTION public\.sync_sales_order_delivery_status/);
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
