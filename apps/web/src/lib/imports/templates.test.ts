import { describe, it, expect } from "vitest";
import { buildImportTemplateCSV, buildImportTemplateXlsx, getTemplateVersionInfo, importTemplateFilename } from "./templates";
import { parseImportFile } from "@/lib/data-onboarding/core/parsing";
import { IMPORT_TYPES, DOMAIN_FIELDS } from "./types";

describe("Template CSV+XLSX tersedia untuk SEMUA 5 domain MVP (LANGKAH D)", () => {
  for (const type of IMPORT_TYPES) {
    it(`${type}: template CSV bisa dibaca ulang lewat pipeline import yang sama, header cocok dengan DOMAIN_FIELDS`, async () => {
      const csv = buildImportTemplateCSV(type);
      const bytes = new TextEncoder().encode(csv);
      const result = await parseImportFile(`template.csv`, bytes);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const labels = DOMAIN_FIELDS[type].map((f) => f.label);
      expect(result.workbook.sheets[0]!.headers).toEqual(labels);
      expect(result.workbook.sheets[0]!.rows).toHaveLength(1); // satu baris contoh
    });

    it(`${type}: template XLSX bisa dibaca ulang lewat pipeline import yang sama, satu worksheet, tanpa formula, tanpa data klien nyata`, async () => {
      const buf = await buildImportTemplateXlsx(type);
      const result = await parseImportFile(`template.xlsx`, new Uint8Array(buf));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workbook.sheets).toHaveLength(1);
      const labels = DOMAIN_FIELDS[type].map((f) => f.label);
      expect(result.workbook.sheets[0]!.headers).toEqual(labels);
      expect(result.workbook.sheets[0]!.rows).toHaveLength(1);
      for (const cell of result.workbook.sheets[0]!.rows[0]!) {
        expect(cell).not.toContain("XLSX_FORMULA_CELL");
        expect(cell.toLowerCase()).not.toContain("sumber warna alam"); // tidak ada data Waluyo nyata di template universal
      }
    });

    it(`${type}: getTemplateVersionInfo mengembalikan versi valid`, () => {
      const info = getTemplateVersionInfo(type);
      expect(info.domain).toBe(type);
      expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  }

  it("nama file template CSV vs XLSX berbeda ekstensi tapi domain sama", () => {
    expect(importTemplateFilename("CUSTOMER_PIC", "csv")).toBe("template-import-customer-pic.csv");
    expect(importTemplateFilename("CUSTOMER_PIC", "xlsx")).toBe("template-import-customer-pic.xlsx");
  });
});
