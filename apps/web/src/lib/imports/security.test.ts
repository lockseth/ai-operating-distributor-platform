import { describe, it, expect } from "vitest";
import {
  checkFileExtension, checkFileSize, checkFileContentMagicBytes, checkRowCount, checkSheetCount,
  sanitizeFilename, neutralizeFormulaInjection, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, MAX_XLSX_SHEETS,
} from "./security";

describe("XLSX kini didukung, format berbahaya tetap ditolak", () => {
  it("ekstensi .xlsx diterima (LANGKAH A)", () => {
    expect(checkFileExtension("data.xlsx").ok).toBe(true);
  });
  it("ekstensi .csv diterima", () => {
    expect(checkFileExtension("data.csv").ok).toBe(true);
  });
  it(".xls/.xlsm/.xlsb ditolak eksplisit (bukan XLSX modern/macro-enabled)", () => {
    expect(checkFileExtension("data.xls").ok).toBe(false);
    expect(checkFileExtension("data.xlsm").ok).toBe(false);
    expect(checkFileExtension("data.xlsb").ok).toBe(false);
  });
  it(".xls ditolak dengan pesan spesifik sesuai kontrak ERP master data (bukan pesan generik)", () => {
    const result = checkFileExtension("NAMA PELANGGAN SWAS.xls");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Format Excel lama .xls terdeteksi. Simpan sebagai .xlsx atau gunakan konverter.");
  });
  it("ekstensi lain (mis. .exe, .zip polos) ditolak", () => {
    expect(checkFileExtension("data.exe").ok).toBe(false);
    expect(checkFileExtension("data.zip").ok).toBe(false);
  });
});

describe("Magic-byte validation membedakan 3 kasus (LANGKAH B)", () => {
  it("1. ZIP valid yang memang klaim .xlsx -> lolos magic-byte check (verifikasi struktur lebih lanjut oleh parser)", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(checkFileContentMagicBytes(zipMagic, ".xlsx").ok).toBe(true);
  });
  it("2a. Fake .xlsx: konten sebenarnya BUKAN zip sama sekali -> ditolak", () => {
    const notZip = new TextEncoder().encode("nama,telepon\nbudi,08123\n");
    expect(checkFileContentMagicBytes(notZip, ".xlsx").ok).toBe(false);
  });
  it("2b. Workbook lama/terenkripsi (magic bytes OLE/CFB) diklaim .xlsx -> ditolak", () => {
    const oleMagic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const result = checkFileContentMagicBytes(oleMagic, ".xlsx");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lama|terenkripsi/);
  });
  it("3. CSV yang diganti ekstensi jadi .xlsx TIDAK bisa lolos hanya lewat ganti nama -- magic bytes tetap teks polos, bukan ZIP", () => {
    const csvContent = new TextEncoder().encode("nama,telepon\nbudi,08123\n");
    expect(checkFileContentMagicBytes(csvContent, ".xlsx").ok).toBe(false);
  });
  it("File .csv yang isinya sebenarnya ZIP/xlsx (ganti ekstensi sebaliknya) ditolak juga", () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(checkFileContentMagicBytes(zipMagic, ".csv").ok).toBe(false);
  });
  it("file executable (magic bytes MZ) ditolak untuk kedua klaim ekstensi", () => {
    const exeMagic = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    expect(checkFileContentMagicBytes(exeMagic, ".csv").ok).toBe(false);
    expect(checkFileContentMagicBytes(exeMagic, ".xlsx").ok).toBe(false);
  });
  it("konten CSV murni (bukan ZIP/EXE) dengan klaim .csv diterima", () => {
    const csvBytes = new TextEncoder().encode("nama,telepon\n");
    expect(checkFileContentMagicBytes(csvBytes, ".csv").ok).toBe(true);
  });
});

describe("Limit ukuran/baris/sheet ditegakkan", () => {
  it("ukuran file melebihi batas ditolak", () => {
    expect(checkFileSize(MAX_IMPORT_FILE_BYTES + 1).ok).toBe(false);
  });
  it("ukuran dalam batas diterima", () => {
    expect(checkFileSize(1024).ok).toBe(true);
  });
  it("file kosong ditolak", () => {
    expect(checkFileSize(0).ok).toBe(false);
  });
  it("jumlah baris melebihi batas ditolak", () => {
    expect(checkRowCount(MAX_IMPORT_ROWS + 1).ok).toBe(false);
  });
  it("jumlah baris dalam batas diterima", () => {
    expect(checkRowCount(100).ok).toBe(true);
  });
  it("jumlah sheet melebihi batas ditolak", () => {
    expect(checkSheetCount(MAX_XLSX_SHEETS + 1).ok).toBe(false);
  });
  it("workbook tanpa sheet ditolak", () => {
    expect(checkSheetCount(0).ok).toBe(false);
  });
  it("jumlah sheet dalam batas diterima", () => {
    expect(checkSheetCount(3).ok).toBe(true);
  });
});

describe("Path traversal pada nama file tidak dieksekusi", () => {
  it("sanitizeFilename membuang ../ dan pemisah path", () => {
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("..");
    expect(sanitizeFilename("../../etc/passwd")).not.toMatch(/[/\\]/);
  });
  it("checkFileExtension menolak nama file mengandung path traversal", () => {
    expect(checkFileExtension("../../evil.csv").ok).toBe(false);
  });
});

describe("Formula injection (CSV) dinetralisasi, tidak pernah dieksekusi", () => {
  it("cell diawali '=' dinetralisasi dengan prefix apostrophe, nilai tetap tersimpan sebagai teks", () => {
    const result = neutralizeFormulaInjection("=SUM(A1:A10)");
    expect(result.wasNeutralized).toBe(true);
    expect(result.value).toBe("'=SUM(A1:A10)");
  });
  it("cell diawali '+', '-', '@' juga dinetralisasi", () => {
    expect(neutralizeFormulaInjection("+1+1").wasNeutralized).toBe(true);
    expect(neutralizeFormulaInjection("-2+3").wasNeutralized).toBe(true);
    expect(neutralizeFormulaInjection("@SUM(1)").wasNeutralized).toBe(true);
  });
  it("teks biasa tidak diubah", () => {
    const result = neutralizeFormulaInjection("Toko Sinar Jaya");
    expect(result.wasNeutralized).toBe(false);
    expect(result.value).toBe("Toko Sinar Jaya");
  });
});
