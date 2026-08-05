// =============================================================================
// Universal Data Onboarding Core — tipe generik, TIDAK BOLEH mengimpor schema
// AODP (customers/products/sales_orders/dll) atau domain adapter apa pun.
// Dipakai oleh AODP adapter (lib/imports/*) dan siapa pun tenant/produk lain
// yang butuh staged file import (CSV/XLSX -> mapping -> validate -> commit).
// =============================================================================

/** Definisi satu field target -- domain-agnostic, diisi oleh adapter (mis. lib/imports/types.ts). */
export interface FieldDefinition {
  key: string;
  label: string;
  required: boolean;
  type: "text" | "phone" | "email" | "date" | "currency" | "number" | "boolean" | "roles";
  example: string;
  aliases: readonly string[];
}

export interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
}

export type RowValidationStatus = "VALID" | "WARNING" | "DUPLICATE" | "ERROR";
export type ProposedAction = "CREATE" | "UPDATE" | "SKIP_DUPLICATE" | "NEEDS_REVIEW";

export interface RowFieldError {
  field: string;
  message: string;
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: string[][];
  /** Jumlah baris preamble (judul/logo, <2 kolom terisi) yang dilewati sebelum header ditemukan -- XLSX saja, transparan (bukan dibuang diam-diam). Undefined/0 untuk CSV (header selalu baris pertama). */
  preambleRowsSkipped?: number;
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  /** true jika file sumbernya CSV (selalu tepat 1 "sheet" sintetis). */
  isSingleSheetSource: boolean;
}

export interface FileSecurityCheckResult {
  ok: boolean;
  reason?: string;
}

/** Model hasil validasi satu baris -- universal, dipakai semua adapter domain. */
export interface RowValidationResult {
  validationStatus: RowValidationStatus;
  proposedAction: ProposedAction;
  errors: RowFieldError[];
  warnings: RowFieldError[];
  detectedExistingId: string | null;
  normalizedData: Record<string, unknown>;
}

export interface ReconciliationSummary {
  sourceTotal: number;
  importTotal: number;
  excludedTotal: number;
  difference: number;
  toleranceUsed: number;
  withinTolerance: boolean;
}

export type ImportBatchStatus =
  | "UPLOADED" | "MAPPED" | "VALIDATED" | "READY_TO_COMMIT"
  | "COMMITTED" | "FAILED" | "ROLLED_BACK";

export interface RollbackBlocker {
  rowNumber: number;
  entityTable: string;
  entityId: string;
  reason: string;
}

/** Kontrak audit event universal -- adapter memetakan action string-nya sendiri, core hanya mendefinisikan bentuk payload. */
export interface ImportAuditEvent {
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}

/** Metadata versi template -- LANGKAH template versioning (addendum). */
export interface TemplateVersionInfo {
  templateId: string;
  domain: string;
  version: string;
  generatedAt: string;
  backwardCompatiblePolicy: string;
}

/**
 * Mapping kolom tersimpan per tenant, di-key oleh (companyId, domain,
 * sourceSystem, profileName) -- addendum "SAVED IMPORT PROFILE". Generik atas
 * `domain: string`, BUKAN `ImportType` AODP -- adapter apa pun (AODP atau
 * bukan) bisa memakai bentuk ini lewat implementasi MappingProfileStore-nya
 * sendiri. Core tidak pernah menyentuh Postgres/Supabase secara langsung.
 */
export interface MappingProfile {
  id: string;
  companyId: string;
  domain: string;
  sourceSystem: string;
  profileName: string;
  columnMappings: ColumnMapping[];
  templateVersion: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MappingProfileInput {
  companyId: string;
  domain: string;
  sourceSystem: string;
  profileName: string;
  columnMappings: ColumnMapping[];
  templateVersion: string;
  createdBy: string;
}

/** Kontrak penyimpanan profil mapping -- diimplementasikan oleh adapter (mis. lib/imports/mapping-profiles.ts via Supabase). */
export interface MappingProfileStore {
  saveProfile(input: MappingProfileInput): Promise<MappingProfile>;
  listProfiles(companyId: string, domain: string): Promise<MappingProfile[]>;
  getProfile(companyId: string, id: string): Promise<MappingProfile | null>;
}
