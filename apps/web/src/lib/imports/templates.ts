// =============================================================================
// AODP adapter — downloadable template per domain (LANGKAH D + template
// versioning addendum). Generasi CSV/XLSX sesungguhnya ada di Universal Core
// (lib/data-onboarding/core/templates.ts, generik atas FieldDefinition[]);
// file ini hanya menjembatani ImportType -> DOMAIN_FIELDS + metadata versi
// AODP-specific.
// =============================================================================

import { buildCsvTemplate, buildXlsxTemplate, buildTemplateVersionInfo } from "@/lib/data-onboarding/core/templates";
import { DOMAIN_FIELDS, IMPORT_TYPE_LABEL, type ImportType } from "./types";
import type { TemplateVersionInfo } from "@/lib/data-onboarding/core/types";

/**
 * Versi template per domain. Field WAJIB baru hanya boleh ditambah lewat
 * kenaikan versi mayor (mis. 1.x -> 2.0) -- field baru pada versi minor
 * SELALU opsional, supaya mapping profile tersimpan dari versi lama tetap
 * valid dipetakan ke template versi baru (backward-compat, lihat
 * docs/architecture/UNIVERSAL_DATA_ONBOARDING.md).
 */
const TEMPLATE_VERSION: Record<ImportType, string> = {
  // 1.1.0: field aditif/opsional (store_city, store_province) + pic_*/price
  // jadi opsional -- kompatibel dengan mapping profile versi 1.0.0 lama
  // (minor bump, bukan major, sesuai isTemplateVersionCompatible).
  CUSTOMER_PIC: "1.1.0",
  PRODUCT_PRICE: "1.1.0",
  OPEN_AR: "1.0.0",
  OPEN_ORDER: "1.0.0",
  HISTORICAL_ORDER: "1.0.0",
};

export function getTemplateVersionInfo(type: ImportType): TemplateVersionInfo {
  return buildTemplateVersionInfo(`aodp-${type.toLowerCase()}`, type, TEMPLATE_VERSION[type]);
}

export function buildImportTemplateCSV(type: ImportType): string {
  return buildCsvTemplate(IMPORT_TYPE_LABEL[type], DOMAIN_FIELDS[type]);
}

export async function buildImportTemplateXlsx(type: ImportType): Promise<Buffer> {
  return buildXlsxTemplate(IMPORT_TYPE_LABEL[type], DOMAIN_FIELDS[type]);
}

export function importTemplateFilename(type: ImportType, extension: "csv" | "xlsx" = "csv"): string {
  return `template-import-${type.toLowerCase().replace(/_/g, "-")}.${extension}`;
}
