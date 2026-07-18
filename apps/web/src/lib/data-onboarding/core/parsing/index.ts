// =============================================================================
// Universal Data Onboarding Core — entry point parsing terpadu CSV+XLSX.
// =============================================================================

import { parseCsvWorkbook } from "./csv";
import { parseXlsxWorkbook } from "./xlsx";
import {
  checkFileExtension, checkFileSize, checkFileContentMagicBytes,
  checkSheetCount, MAX_XLSX_SHEETS, MAX_IMPORT_ROWS, MAX_XLSX_CELLS_PER_SHEET,
} from "../security";
import type { ParsedWorkbook } from "../types";

export type ParseFileResult =
  | { ok: true; workbook: ParsedWorkbook }
  | { ok: false; reason: string };

export interface ParseFileOptions {
  maxFileBytes?: number;
  maxRows?: number;
  maxSheets?: number;
  maxCellsPerSheet?: number;
}

/**
 * Satu pintu masuk untuk file import (CSV atau XLSX). Melakukan SEMUA
 * pengecekan keamanan (extension, magic bytes, size) sebelum parsing --
 * pipeline validasi/mapping DI HILIR sepenuhnya sama untuk kedua format
 * (keduanya menghasilkan ParsedWorkbook yang sama bentuknya).
 */
export async function parseImportFile(
  filename: string,
  bytes: Uint8Array,
  opts: ParseFileOptions = {}
): Promise<ParseFileResult> {
  const extCheck = checkFileExtension(filename);
  if (!extCheck.ok) return { ok: false, reason: extCheck.reason! };

  const sizeCheck = checkFileSize(bytes.length, opts.maxFileBytes);
  if (!sizeCheck.ok) return { ok: false, reason: sizeCheck.reason! };

  const isXlsx = filename.toLowerCase().endsWith(".xlsx");
  const magicCheck = checkFileContentMagicBytes(bytes, isXlsx ? ".xlsx" : ".csv");
  if (!magicCheck.ok) return { ok: false, reason: magicCheck.reason! };

  if (isXlsx) {
    const result = await parseXlsxWorkbook(Buffer.from(bytes), {
      maxSheets: opts.maxSheets ?? MAX_XLSX_SHEETS,
      maxRows: opts.maxRows ?? MAX_IMPORT_ROWS,
      maxCellsPerSheet: opts.maxCellsPerSheet ?? MAX_XLSX_CELLS_PER_SHEET,
    });
    if (!result.ok) return result;
    const sheetCheck = checkSheetCount(result.workbook.sheets.length, opts.maxSheets ?? MAX_XLSX_SHEETS);
    if (!sheetCheck.ok) return { ok: false, reason: sheetCheck.reason! };
    return result;
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  const workbook = parseCsvWorkbook(text);
  if (workbook.sheets[0]!.headers.length === 0) {
    return { ok: false, reason: "File tidak memiliki header/kolom yang bisa dibaca." };
  }
  return { ok: true, workbook };
}
