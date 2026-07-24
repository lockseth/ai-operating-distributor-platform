// =============================================================================
// Invoiced Status Integrity Containment Gate -- static assertion atas
// apps/web/src/app/(dashboard)/dashboard/finance/page.tsx. Halaman ini
// server component async (fetch Supabase langsung) -- repo tidak punya
// harness render (vitest.config.ts: environment "node", tanpa jsdom/
// @testing-library/react), jadi pembuktian "tidak lagi menghitung/menampilkan
// Piutang Invoice dari status order" dilakukan lewat pembacaan source
// langsung, pola sama seperti audit-log/security.test.ts dan
// invoiced-lock-migration.security.test.ts.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const financePage = readFileSync(
  path.resolve(
    __dirname,
    "../../app/(dashboard)/dashboard/finance/page.tsx",
  ),
  "utf8",
);

describe("Invoiced Status Integrity Containment -- Finance Dashboard", () => {
  it("tidak lagi query sales_orders dengan status='invoiced'", () => {
    expect(financePage).not.toMatch(/\.eq\(\s*["']status["']\s*,\s*["']invoiced["']\s*\)/);
  });

  it("tidak lagi menampilkan kartu berlabel 'Piutang Invoice'", () => {
    expect(financePage).not.toContain("Piutang Invoice");
  });

  it("tidak diganti dengan estimasi/placeholder finansial (final_amount, issued_documents, legacy_ar_invoices)", () => {
    expect(financePage).not.toContain("final_amount");
    expect(financePage).not.toContain("issued_documents");
    expect(financePage).not.toContain("legacy_ar_invoices");
  });

  it("kartu 'Pembayaran Terverifikasi' (containment paid, gate sebelumnya) tetap ada dan tidak diregresi", () => {
    expect(financePage).toContain("Pembayaran Terverifikasi");
    expect(financePage).toContain("Belum tersedia");
  });

  it("tidak lagi query sales_orders dengan status='paid' juga (regresi containment sebelumnya)", () => {
    expect(financePage).not.toMatch(/\.eq\(\s*["']status["']\s*,\s*["']paid["']\s*\)/);
  });
});
