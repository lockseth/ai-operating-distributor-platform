// =============================================================================
// AODP adapter — re-export file security dari Universal Core
// (lib/data-onboarding/core/security.ts). Tidak ada logic AODP-specific di
// sini; file ini dipertahankan supaya call site lama (lib/imports/*) tidak
// perlu diubah semua sekaligus.
// =============================================================================

export {
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, MAX_XLSX_SHEETS, MAX_XLSX_CELLS_PER_SHEET,
  sanitizeFilename, checkFileExtension, checkFileSize, checkFileContentMagicBytes,
  checkRowCount, checkSheetCount, neutralizeFormulaInjection, sha256Hex,
  XLSX_FORMULA_CELL_MARKER,
} from "@/lib/data-onboarding/core/security";
