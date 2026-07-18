import { describe, it, expect } from "vitest";
import { buildCsvTemplate, buildXlsxTemplate, buildTemplateVersionInfo, isTemplateVersionCompatible } from "./templates";
import { parseXlsxWorkbook } from "./parsing/xlsx";
import { parseCsvWorkbook } from "./parsing/csv";
import type { FieldDefinition } from "./types";

const SAMPLE_FIELDS: FieldDefinition[] = [
  { key: "name", label: "Nama", required: true, type: "text", example: "Contoh Nama", aliases: ["nama"] },
  { key: "phone", label: "Telepon", required: false, type: "phone", example: "081234567890", aliases: ["telepon", "hp"] },
];

describe("Universal Core template primitives -- generik, dipakai adapter mana pun (LANGKAH D + template versioning)", () => {
  it("template XLSX yang di-generate bisa dibaca kembali oleh parser XLSX yang sama (round-trip)", async () => {
    const buf = await buildXlsxTemplate("Domain Uji", SAMPLE_FIELDS);
    const result = await parseXlsxWorkbook(buf, { maxSheets: 20, maxRows: 100, maxCellsPerSheet: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workbook.sheets).toHaveLength(1);
    expect(result.workbook.sheets[0]!.headers).toEqual(["Nama", "Telepon"]);
    expect(result.workbook.sheets[0]!.rows).toEqual([["Contoh Nama", "081234567890"]]);
  });

  it("template XLSX tidak pernah berisi formula (hanya cell data biasa)", async () => {
    const buf = await buildXlsxTemplate("Domain Uji", SAMPLE_FIELDS);
    const result = await parseXlsxWorkbook(buf, { maxSheets: 20, maxRows: 100, maxCellsPerSheet: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const row of result.workbook.sheets[0]!.rows) {
      for (const cell of row) expect(cell).not.toContain("XLSX_FORMULA_CELL");
    }
  });

  it("template CSV yang di-generate bisa dibaca kembali oleh parser CSV yang sama", () => {
    const csv = buildCsvTemplate("Domain Uji", SAMPLE_FIELDS);
    const workbook = parseCsvWorkbook(csv);
    expect(workbook.sheets[0]!.headers).toEqual(["Nama", "Telepon"]);
    expect(workbook.sheets[0]!.rows).toEqual([["Contoh Nama", "081234567890"]]);
  });

  it("buildTemplateVersionInfo mengembalikan metadata versi lengkap", () => {
    const info = buildTemplateVersionInfo("test-domain", "TEST_DOMAIN", "1.0.0");
    expect(info.templateId).toBe("test-domain");
    expect(info.domain).toBe("TEST_DOMAIN");
    expect(info.version).toBe("1.0.0");
    expect(info.backwardCompatiblePolicy.length).toBeGreaterThan(0);
    expect(new Date(info.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("isTemplateVersionCompatible: mapping profile versi mayor sama dianggap kompatibel", () => {
    expect(isTemplateVersionCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isTemplateVersionCompatible("1.0.0", "1.3.0")).toBe(true); // minor baru, tetap kompatibel
  });

  it("isTemplateVersionCompatible: kenaikan MAYOR butuh mapping ulang eksplisit (tidak kompatibel otomatis)", () => {
    expect(isTemplateVersionCompatible("1.0.0", "2.0.0")).toBe(false);
  });
});
