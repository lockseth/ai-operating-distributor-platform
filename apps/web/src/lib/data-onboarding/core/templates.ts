// =============================================================================
// Universal Data Onboarding Core — template-generation primitives. Generik:
// menerima daftar FieldDefinition + metadata domain dari adapter, tidak tahu
// apa pun soal domain/tenant tertentu.
// =============================================================================

import ExcelJS from "exceljs";
import type { FieldDefinition, TemplateVersionInfo } from "./types";

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCsvTemplate(domainLabel: string, fields: readonly FieldDefinition[]): string {
  const lines: string[] = [];
  lines.push(`# Template import: ${domainLabel}`);
  lines.push("# Format tanggal: DD/MM/YYYY. Format nominal: 1.500.000 atau 1500000 (tanpa simbol mata uang, koma untuk desimal).");
  lines.push("# Format nomor telepon: boleh 08xx, 62xx, atau +62xx.");
  for (const f of fields) {
    lines.push(`# ${f.label}${f.required ? " (WAJIB)" : " (opsional)"} -- kolom: ${f.key}`);
  }
  lines.push("");

  const header = fields.map((f) => csvEscape(f.label)).join(",");
  const example = fields.map((f) => csvEscape(f.example)).join(",");
  lines.push(header);
  lines.push(example);

  return lines.join("\n");
}

/**
 * Satu worksheet, header canonical (baris 1), satu baris dummy sintetis
 * (baris 2), cell data biasa (TIDAK PERNAH formula). Tidak ada data klien
 * nyata -- murni contoh.
 */
export async function buildXlsxTemplate(domainLabel: string, fields: readonly FieldDefinition[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AODP Universal Data Onboarding";
  wb.created = new Date();

  const ws = wb.addWorksheet(domainLabel.slice(0, 31)); // Excel sheet name limit 31 char.
  ws.addRow(fields.map((f) => f.label));
  ws.addRow(fields.map((f) => f.example)); // Nilai string biasa -- ExcelJS tidak pernah menyisipkan formula dari string biasa.

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

export function importTemplateFilename(domainKey: string, extension: "csv" | "xlsx"): string {
  return `template-import-${domainKey.toLowerCase().replace(/_/g, "-")}.${extension}`;
}

export function buildTemplateVersionInfo(templateId: string, domain: string, version: string): TemplateVersionInfo {
  return {
    templateId, domain, version,
    generatedAt: new Date().toISOString(),
    backwardCompatiblePolicy:
      "Kolom baru pada versi berikutnya selalu opsional secara default -- importer versi lama tetap bisa memetakan template versi baru tanpa field wajib yang hilang. Kolom wajib hanya dihapus/di-rename lewat mayor version baru, versi lama tetap didukung untuk mapping profile yang sudah tersimpan.",
  };
}

/**
 * Kebijakan kompatibilitas versi template (LANGKAH template versioning):
 * mapping profile yang tersimpan pada versi MAYOR yang sama tetap dianggap
 * kompatibel (field baru pada minor/patch version selalu opsional, lihat
 * backwardCompatiblePolicy di atas) -- hanya kenaikan MAYOR yang butuh
 * pemetaan ulang eksplisit oleh admin.
 */
export function isTemplateVersionCompatible(savedVersion: string, currentVersion: string): boolean {
  const savedMajor = Number(savedVersion.split(".")[0]);
  const currentMajor = Number(currentVersion.split(".")[0]);
  if (Number.isNaN(savedMajor) || Number.isNaN(currentMajor)) return false;
  return savedMajor === currentMajor;
}
