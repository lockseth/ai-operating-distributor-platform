// =============================================================================
// Universal Data Onboarding Core — CSV parsing. Reuse parser hand-rolled yang
// sudah ada (apps/web/src/lib/settings/csv-parser.ts, pure string utility,
// bukan domain adapter/schema AODP) supaya tidak menduplikasi logic parsing.
// =============================================================================

import { parseCSVText } from "@/lib/settings/csv-parser";
import type { ParsedWorkbook } from "../types";

/**
 * Baris kosong dan baris komentar (diawali "#", dipakai template download
 * untuk penjelasan field) dibuang sebelum parsing -- supaya admin bisa upload
 * ulang template yang sudah diisi tanpa perlu menghapus baris petunjuk.
 */
export function parseCsvWorkbook(text: string): ParsedWorkbook {
  const cleaned = text
    .split(/\r\n|\r|\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  const { headers, rows } = parseCSVText(cleaned, ",", true);
  return {
    sheets: [{ name: "CSV", headers: headers.map((h) => h.trim()), rows }],
    isSingleSheetSource: true,
  };
}
