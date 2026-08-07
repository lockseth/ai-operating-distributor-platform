// =============================================================================
// Gate 3E-D4-C7 — static assertions membuktikan widget "Order Pending / Perlu
// konfirmasi" pada Manager Dashboard memakai status canonical yang BENAR-BENAR
// ada (draft), bukan lagi 'pending' -- nilai yang TIDAK PERNAH muncul di
// sales_orders_status_check manapun (lihat migration
// 20260923000001_gate_3e_d4_c1_special_price_approval_schema.sql), sehingga
// filter lama tidak pernah cocok satu baris pun dan draft (termasuk draft
// Telegram menunggu KONFIRMASI Sales) tidak pernah terhitung/terlihat.
//
// Pola pengujian (baca file mentah, assert pattern) identik
// gate-3e-d4-c6-flag-enforcement.security.test.ts -- halaman ini server
// component yang query Supabase langsung, tidak ada harness render Next.js
// di test suite ini, jadi kontrak status difixasi secara statis.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");
const statusCheckMigration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../../../supabase/migrations/20260923000001_gate_3e_d4_c1_special_price_approval_schema.sql",
  ),
  "utf8",
);

describe("Gate 3E-D4-C7: Manager Dashboard 'Order Pending' widget", () => {
  it("status CHECK constraint (sumber kebenaran) TIDAK PERNAH memuat nilai 'pending' -- membuktikan filter lama mati total", () => {
    const constraintIdx = statusCheckMigration.indexOf("ADD CONSTRAINT sales_orders_status_check");
    expect(constraintIdx).toBeGreaterThan(-1);
    const constraintBlock = statusCheckMigration.slice(constraintIdx, constraintIdx + 300);
    expect(constraintBlock).toContain("'draft'");
    expect(constraintBlock).toContain("'pending_owner_approval'");
    expect(constraintBlock).not.toMatch(/'pending'(?!_owner_approval)/);
  });

  it("halaman Manager Dashboard memfilter widget pending-confirmation dengan status='draft', BUKAN 'pending'", () => {
    const commentIdx = page.indexOf("Gate 3E-D4-C7:");
    expect(commentIdx).toBeGreaterThan(-1);
    const queryBlock = page.slice(commentIdx, page.indexOf("]);", commentIdx));
    expect(queryBlock).toContain('.eq("status", "draft")');
    expect(queryBlock).not.toMatch(/\.in\("status",\s*\[[^\]]*"pending"[^\]]*\]\)/);
    expect(queryBlock).not.toMatch(/\.eq\("status",\s*"pending"\)/);
  });

  it("widget pending-confirmation TIDAK menyamakan draft dengan pending_owner_approval (kontrak berbeda, Sales vs Owner)", () => {
    const commentIdx = page.indexOf("Gate 3E-D4-C7:");
    const queryBlock = page.slice(commentIdx, page.indexOf("]);", commentIdx));
    expect(queryBlock).not.toMatch(/\.eq\("status",\s*"pending_owner_approval"\)/);
  });

  it("widget pending-confirmation tetap tenant-scoped (company_id)", () => {
    const commentIdx = page.indexOf("Gate 3E-D4-C7:");
    const widgetStart = page.lastIndexOf(".from(\"sales_orders\")", commentIdx);
    const queryBlock = page.slice(widgetStart, page.indexOf("]);", commentIdx));
    expect(queryBlock).toContain('.eq("company_id", user.company_id)');
  });
});
