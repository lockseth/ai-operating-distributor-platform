// =============================================================================
// TEST TAMBAHAN (addendum) -- membuktikan boundary Universal Core / AODP
// Adapter benar-benar ditegakkan: dependency SATU ARAH (AODP -> Core), core
// tidak pernah tahu apa pun soal schema/domain AODP, dan adapter DOMAIN LAIN
// (bukan AODP) bisa memakai core tanpa mengimpor apa pun dari lib/imports.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { validateMappingCompleteness } from "./mapping";
import { parseCsvWorkbook } from "./parsing/csv";
import { defaultSuggestMapping, type ImportDomainAdapter } from "./adapter";
import type { FieldDefinition, RowValidationResult } from "./types";

const CORE_DIR = join(__dirname); // apps/web/src/lib/data-onboarding/core

function listCoreSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listCoreSourceFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("Boundary structural: Universal Core TIDAK PERNAH mengimpor AODP adapter/schema", () => {
  it("tidak ada file di lib/data-onboarding/core yang mengimpor dari @/lib/imports (arah dependency satu arah)", () => {
    const files = listCoreSourceFiles(CORE_DIR);
    expect(files.length).toBeGreaterThan(5); // sanity: pastikan scan benar-benar jalan, bukan folder kosong

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      if (/from\s+["']@\/lib\/imports/.test(content)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("tidak ada file core yang menyebut nama tabel schema AODP secara langsung (customers/sales_orders/import_batches/dst)", () => {
    const files = listCoreSourceFiles(CORE_DIR);
    const aodpTableNames = ["\"customers\"", "\"customer_pics\"", "\"sales_orders\"", "\"import_batches\"", "\"legacy_ar_invoices\"", "\"products\""];
    const violations: { file: string; table: string }[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const table of aodpTableNames) {
        if (content.includes(table)) violations.push({ file, table });
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("Fake domain adapter (BUKAN AODP) bisa memakai Universal Core tanpa schema AODP apa pun", () => {
  // Domain fiktif "INVENTORY_SNAPSHOT" -- sengaja bukan salah satu dari 5 domain
  // AODP, untuk membuktikan core benar-benar generik.
  const FAKE_FIELDS: readonly FieldDefinition[] = [
    { key: "warehouse_code", label: "Kode Gudang", required: true, type: "text", example: "WH-01", aliases: ["kode gudang", "warehouse"] },
    { key: "item_sku", label: "SKU Barang", required: true, type: "text", example: "ITM-001", aliases: ["sku"] },
    { key: "quantity_on_hand", label: "Stok Tersedia", required: true, type: "number", example: "100", aliases: ["stok", "qty"] },
  ];

  class FakeInventoryAdapter implements ImportDomainAdapter<undefined, { count: number }, { reverted: number }> {
    readonly domain = "INVENTORY_SNAPSHOT";
    private committed: Record<string, string>[] = [];

    canonicalColumns() { return FAKE_FIELDS; }
    suggestMapping = defaultSuggestMapping(FAKE_FIELDS);

    async validateRow(mappedRow: Record<string, string>): Promise<RowValidationResult> {
      const errors = FAKE_FIELDS.filter((f) => f.required && !mappedRow[f.key]?.trim())
        .map((f) => ({ field: f.key, message: `${f.label} wajib diisi.` }));
      if (errors.length > 0) {
        return { validationStatus: "ERROR", proposedAction: "NEEDS_REVIEW", errors, warnings: [], detectedExistingId: null, normalizedData: {} };
      }
      return { validationStatus: "VALID", proposedAction: "CREATE", errors: [], warnings: [], detectedExistingId: null, normalizedData: { ...mappedRow } };
    }

    async commitBatch() { this.committed.push({}); return { count: this.committed.length }; }
    async rollbackBatch() { return { reverted: this.committed.length }; }
  }

  it("adapter fiktif bisa membuat canonical columns + suggest mapping lewat core, tanpa satu pun impor AODP", () => {
    const adapter = new FakeInventoryAdapter();
    expect(adapter.canonicalColumns()).toHaveLength(3);
    const suggested = adapter.suggestMapping(["Kode Gudang", "SKU Barang", "Stok Tersedia"]);
    expect(suggested.find((m) => m.sourceColumn === "Kode Gudang")?.targetField).toBe("warehouse_code");
  });

  it("adapter fiktif bisa memvalidasi baris & parsing CSV generik lewat core secara end-to-end", async () => {
    const adapter = new FakeInventoryAdapter();
    const csv = "warehouse_code,item_sku,quantity_on_hand\nWH-01,ITM-001,100\n";
    const workbook = parseCsvWorkbook(csv);
    expect(workbook.sheets[0]!.headers).toEqual(["warehouse_code", "item_sku", "quantity_on_hand"]);

    const [headerRow] = workbook.sheets[0]!.rows;
    const mapped: Record<string, string> = {};
    workbook.sheets[0]!.headers.forEach((h, i) => { mapped[h] = headerRow![i] ?? ""; });

    const result = await adapter.validateRow(mapped);
    expect(result.validationStatus).toBe("VALID");
    expect(result.proposedAction).toBe("CREATE");

    const commitResult = await adapter.commitBatch();
    expect(commitResult.count).toBe(1);
  });

  it("mapping completeness generik core menolak baris yang belum lengkap untuk domain fiktif ini", () => {
    const completeness = validateMappingCompleteness(
      [{ sourceColumn: "Kode Gudang", targetField: "warehouse_code" }], // item_sku & quantity_on_hand belum dipetakan
      FAKE_FIELDS
    );
    expect(completeness.ok).toBe(false);
    expect(completeness.missingRequiredFields).toContain("item_sku");
    expect(completeness.missingRequiredFields).toContain("quantity_on_hand");
  });
});
