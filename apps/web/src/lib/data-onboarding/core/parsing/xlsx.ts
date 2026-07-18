// =============================================================================
// Universal Data Onboarding Core — XLSX parsing (ExcelJS). Server-side saja.
//
// Keamanan (LANGKAH B):
//  - tidak pernah mengeksekusi formula -- cell formula ditandai marker
//    khusus, nilainya TIDAK PERNAH diambil dari cache hasil (cell.result)
//    apalagi dieval ulang;
//  - workbook macro-enabled ditolak lewat scan byte mentah untuk entry ZIP
//    "xl/vbaProject.bin" SEBELUM di-load ExcelJS;
//  - workbook terenkripsi ditolak lebih awal oleh security.ts (magic bytes
//    OLE/CFB, format wrapper standar untuk xlsx berpassword) DAN oleh
//    try/catch di sini (ExcelJS gagal parse struktur ZIP kalau memang
//    terenkripsi tapi lolos magic-byte check);
//  - limit sheet/row/cell ditegakkan SELAMA iterasi (berhenti begitu limit
//    tercapai, bukan parse semua dulu baru dibuang);
//  - tidak pernah menulis file sementara ke disk (buffer in-memory saja);
//  - tidak pernah mengekstrak embedded object/gambar (tidak memanggil API
//    ExcelJS untuk itu sama sekali);
//  - tidak mengikuti external link (ExcelJS.load() tidak melakukan network
//    fetch apa pun -- murni parsing struktur zip/xml lokal);
//  - tidak ada path traversal saat baca zip -- ExcelJS menangani ekstraksi
//    entry zip secara internal, kita tidak pernah menulis entry ke path
//    turunan nama entry secara manual.
// =============================================================================

import ExcelJS from "exceljs";
import { XLSX_FORMULA_CELL_MARKER } from "../security";
import type { ParsedWorkbook, ParsedSheet } from "../types";

export interface XlsxParseOptions {
  maxSheets: number;
  maxRows: number;
  maxCellsPerSheet: number;
}

export type XlsxParseResult =
  | { ok: true; workbook: ParsedWorkbook }
  | { ok: false; reason: string };

const VBA_PROJECT_MARKER = Buffer.from("xl/vbaProject.bin", "ascii");

function containsMacroProject(buffer: Buffer): boolean {
  return buffer.includes(VBA_PROJECT_MARKER);
}

export async function parseXlsxWorkbook(buffer: Buffer, opts: XlsxParseOptions): Promise<XlsxParseResult> {
  if (containsMacroProject(buffer)) {
    return { ok: false, reason: "Workbook macro-enabled (berisi VBA project) tidak didukung." };
  }

  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { ok: false, reason: "File XLSX tidak valid, rusak, atau terenkripsi/berpassword." };
  }

  if (wb.worksheets.length === 0) {
    return { ok: false, reason: "Workbook tidak memiliki worksheet." };
  }
  if (wb.worksheets.length > opts.maxSheets) {
    return { ok: false, reason: `Jumlah sheet (${wb.worksheets.length}) melebihi batas ${opts.maxSheets}.` };
  }

  const sheets: ParsedSheet[] = [];

  for (const ws of wb.worksheets) {
    let cellCount = 0;
    let dataRowCount = 0;
    let isFirstDataRow = true;
    let headers: string[] = [];
    const rows: string[][] = [];
    let exceeded: string | null = null;

    ws.eachRow({ includeEmpty: false }, (row) => {
      if (exceeded) return;

      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cellCount += 1;
        if (cellCount > opts.maxCellsPerSheet) {
          exceeded = `Jumlah cell pada sheet "${ws.name}" melebihi batas ${opts.maxCellsPerSheet}.`;
          return;
        }
        if (cell.type === ExcelJS.ValueType.Formula) {
          // Formula TIDAK PERNAH dieksekusi/diambil hasil cache-nya -- ditandai
          // marker khusus, ditolak eksplisit di layer validasi (bukan di sini,
          // supaya pesan error bisa menyebutkan field mana yang bermasalah).
          cells.push(XLSX_FORMULA_CELL_MARKER);
        } else {
          cells.push((cell.text ?? "").toString().trim());
        }
      });
      if (exceeded) return;

      if (isFirstDataRow) {
        headers = cells;
        isFirstDataRow = false;
        return;
      }

      dataRowCount += 1;
      if (dataRowCount > opts.maxRows) {
        exceeded = `Jumlah baris pada sheet "${ws.name}" melebihi batas ${opts.maxRows}.`;
        return;
      }
      rows.push(cells);
    });

    if (exceeded) return { ok: false, reason: exceeded };

    if (headers.length > 0) {
      sheets.push({ name: ws.name, headers, rows });
    }
  }

  if (sheets.length === 0) {
    return { ok: false, reason: "Tidak ada sheet dengan data yang bisa dibaca." };
  }

  return { ok: true, workbook: { sheets, isSingleSheetSource: false } };
}
