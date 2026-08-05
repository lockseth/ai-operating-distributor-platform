import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseXlsxWorkbook } from "./xlsx";
import { XLSX_FORMULA_CELL_MARKER } from "../security";

async function buildWorkbook(sheets: { name: string; rows: string[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) ws.addRow(row);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const DEFAULT_OPTS = { maxSheets: 20, maxRows: 20000, maxCellsPerSheet: 200000 };

describe("parseXlsxWorkbook (LANGKAH G -- XLSX parsing)", () => {
  it("XLSX valid dengan satu sheet berhasil di-parse -- header + baris data terbaca benar", async () => {
    const buf = await buildWorkbook([{ name: "Data", rows: [["nama", "telepon"], ["Budi", "08123"], ["Siti", "08124"]] }]);
    const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workbook.sheets).toHaveLength(1);
    expect(result.workbook.sheets[0]!.headers).toEqual(["nama", "telepon"]);
    expect(result.workbook.sheets[0]!.rows).toEqual([["Budi", "08123"], ["Siti", "08124"]]);
  });

  it("XLSX dengan >1 sheet menghasilkan banyak ParsedSheet (pemilihan sheet ada di service.ts, bukan di sini)", async () => {
    const buf = await buildWorkbook([
      { name: "Toko", rows: [["nama", "kode"], ["Toko A", "T1"]] },
      { name: "Produk", rows: [["sku", "nama"], ["SKU-1", "Barang 1"]] },
    ]);
    const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workbook.sheets.map((s) => s.name)).toEqual(["Toko", "Produk"]);
  });

  it("cell formula TIDAK PERNAH dieksekusi/diambil hasil cache-nya -- diganti marker khusus", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(["nama", "total"]);
    ws.addRow(["Budi", 10]);
    // Baris ke-3, kolom "total" berisi formula dengan hasil cache 999 --
    // hasil cache TIDAK BOLEH pernah terbaca oleh parser.
    ws.getCell(3, 1).value = "Siti";
    ws.getCell(3, 2).value = { formula: "B2*100", result: 999 } as ExcelJS.CellFormulaValue;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.workbook.sheets[0]!.rows[1]!; // baris kedua data (Siti)
    expect(row[1]).toBe(XLSX_FORMULA_CELL_MARKER);
    expect(row[1]).not.toBe("999");
  });

  it("workbook macro-enabled (mengandung xl/vbaProject.bin) ditolak SEBELUM di-load ExcelJS", async () => {
    const buf = await buildWorkbook([{ name: "Data", rows: [["nama"], ["Budi"]] }]);
    // Simulasikan entri ZIP macro tanpa perlu membuat file .xlsm asli --
    // scan byte mentah yang diuji adalah substring match, bukan struktur zip nyata.
    const withMacroMarker = Buffer.concat([buf, Buffer.from("xl/vbaProject.bin", "ascii")]);
    const result = await parseXlsxWorkbook(withMacroMarker, DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/macro/i);
  });

  it("buffer rusak/bukan XLSX valid (walau lolos magic-byte ZIP) ditolak dengan pesan jelas", async () => {
    // Magic byte ZIP valid tapi struktur internal rusak total.
    const corrupted = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("bukan struktur zip yang valid sama sekali")]);
    const result = await parseXlsxWorkbook(corrupted, DEFAULT_OPTS);
    expect(result.ok).toBe(false);
  });

  it("jumlah sheet melebihi batas ditolak", async () => {
    const sheets = Array.from({ length: 5 }, (_, i) => ({ name: `Sheet${i}`, rows: [["a"], ["1"]] }));
    const buf = await buildWorkbook(sheets);
    const result = await parseXlsxWorkbook(buf, { ...DEFAULT_OPTS, maxSheets: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/sheet/i);
  });

  it("jumlah baris melebihi batas ditolak (berhenti begitu limit tercapai)", async () => {
    const rows = [["nama", "kode"], ...Array.from({ length: 10 }, (_, i) => [`Baris ${i}`, `K${i}`])];
    const buf = await buildWorkbook([{ name: "Data", rows }]);
    const result = await parseXlsxWorkbook(buf, { ...DEFAULT_OPTS, maxRows: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/baris/i);
  });

  it("jumlah cell melebihi batas ditolak", async () => {
    const rows = [["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]];
    const buf = await buildWorkbook([{ name: "Data", rows }]);
    const result = await parseXlsxWorkbook(buf, { ...DEFAULT_OPTS, maxCellsPerSheet: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cell/i);
  });

  it("workbook tanpa worksheet sama sekali ditolak", async () => {
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
    expect(result.ok).toBe(false);
  });

  describe("deteksi header setelah baris judul/preamble (ERP master data, LANGKAH kontrak poin 6)", () => {
    it("header TIDAK selalu baris pertama -- baris judul (1 kolom terisi) di atas header sungguhan dilewati transparan", async () => {
      // Mirip layout export ERP asli: baris judul/nama perusahaan/kota/telepon
      // (masing-masing cuma 1 kolom terisi), lalu header sungguhan di baris ke-6.
      const buf = await buildWorkbook([{
        name: "Data",
        rows: [
          ["DAFTAR PELANGGAN"],
          ["PT. SUMBER WARNA ALAM SUDIADA"],
          ["CIREBON"],
          ["085185905859"],
          ["Kode", "Nama", "Alamat", "Kota", "Provinsi", "Telepon"],
          ["PL0001", "TK WIJAYA FROZEN", "PASAR HARJAMUKTI", "CIREBON", "JAWA BARAT", ""],
        ],
      }]);
      const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sheet = result.workbook.sheets[0]!;
      expect(sheet.headers).toEqual(["Kode", "Nama", "Alamat", "Kota", "Provinsi", "Telepon"]);
      expect(sheet.rows).toEqual([["PL0001", "TK WIJAYA FROZEN", "PASAR HARJAMUKTI", "CIREBON", "JAWA BARAT", ""]]);
      // Transparan: jumlah baris preamble yang dilewati tercatat, bukan hilang diam-diam.
      expect(sheet.preambleRowsSkipped).toBe(4);
    });

    it("baris kosong DI TENGAH data (setelah header) dilewati apa adanya, bukan dianggap akhir data", async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Data");
      ws.addRow(["Kode Item", "Nama Item", "Stok"]);
      ws.addRow(["00001", "Produk Satu", "10"]);
      ws.addRow([]); // baris kosong sungguhan di antara data, seperti pada export ERP asli
      ws.addRow(["00002", "Produk Dua", "20"]);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sheet = result.workbook.sheets[0]!;
      expect(sheet.headers).toEqual(["Kode Item", "Nama Item", "Stok"]);
      expect(sheet.rows).toEqual([
        ["00001", "Produk Satu", "10"],
        ["00002", "Produk Dua", "20"],
      ]);
    });

    it("sheet yang tidak pernah punya baris >=2 kolom fallback ke baris pertama sebagai header (perilaku lama, transparan -- bukan hilang diam-diam)", async () => {
      const buf = await buildWorkbook([{ name: "Catatan", rows: [["Judul Saja"], ["Baris Lain Satu Kolom"]] }]);
      const result = await parseXlsxWorkbook(buf, DEFAULT_OPTS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const sheet = result.workbook.sheets[0]!;
      expect(sheet.headers).toEqual(["Judul Saja"]);
      expect(sheet.rows).toEqual([["Baris Lain Satu Kolom"]]);
      expect(sheet.preambleRowsSkipped).toBe(0);
    });
  });
});
