import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseImportFile } from "./index";

async function buildXlsxBuffer(rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data");
  for (const row of rows) ws.addRow(row);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}

describe("parseImportFile -- satu pintu masuk CSV+XLSX (LANGKAH G)", () => {
  it("CSV valid berhasil di-parse", async () => {
    const bytes = new TextEncoder().encode("nama,telepon\nBudi,08123\n");
    const result = await parseImportFile("data.csv", bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workbook.sheets[0]!.headers).toEqual(["nama", "telepon"]);
    expect(result.workbook.isSingleSheetSource).toBe(true);
  });

  it("XLSX valid berhasil di-parse lewat pintu yang sama, hasil ParsedWorkbook berbentuk identik", async () => {
    const bytes = await buildXlsxBuffer([["nama", "telepon"], ["Budi", "08123"]]);
    const result = await parseImportFile("data.xlsx", bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workbook.sheets[0]!.headers).toEqual(["nama", "telepon"]);
    expect(result.workbook.sheets[0]!.rows).toEqual([["Budi", "08123"]]);
  });

  it("fake .xlsx: file CSV biasa yang diganti ekstensi ditolak sebelum sampai ke parser XLSX (bukan cuma nama)", async () => {
    const bytes = new TextEncoder().encode("nama,telepon\nBudi,08123\n");
    const result = await parseImportFile("data.xlsx", bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/csv|lain/i);
  });

  it(".xls (format lama) ditolak sebelum parsing dimulai", async () => {
    const bytes = await buildXlsxBuffer([["nama"], ["Budi"]]);
    const result = await parseImportFile("data.xls", bytes);
    expect(result.ok).toBe(false);
  });

  it("XLSX yang sebenarnya terenkripsi (magic bytes OLE/CFB) ditolak walau ekstensi .xlsx", async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const result = await parseImportFile("terkunci.xlsx", bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/lama|terenkripsi/);
  });

  it("file executable yang diganti ekstensi .xlsx ditolak", async () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const result = await parseImportFile("evil.xlsx", bytes);
    expect(result.ok).toBe(false);
  });
});
