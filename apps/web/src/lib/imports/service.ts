// =============================================================================
// Orkestrasi pipeline import: upload -> stage raw -> map -> validate/dedupe
// -> reconcile -> READY_TO_COMMIT. Commit/rollback sendiri ada di
// actions.ts (memanggil RPC lewat repository, atomic di sisi DB).
//
// Tidak ada temp file OS -- file diproses seluruhnya in-memory dalam satu
// request, lalu baris mentahnya disimpan sebagai staging JSONB (itulah
// "staging" yang diminta LANGKAH 3), bukan file fisik yang perlu dibersihkan.
// =============================================================================

import { parseImportFile } from "@/lib/data-onboarding/core/parsing";
import { sanitizeFilename, sha256Hex, checkRowCount, MAX_IMPORT_ROWS, XLSX_FORMULA_CELL_MARKER } from "@/lib/data-onboarding/core/security";
import { suggestColumnMapping as coreSuggestMapping, validateMappingCompleteness as coreValidateMappingCompleteness } from "@/lib/data-onboarding/core/mapping";
import { computeArReconciliation } from "./reconciliation";
import { validateCustomerPicRow, validateProductPriceRow, validateOpenArRow, validateOrderRow } from "./validators";
import { DOMAIN_FIELDS } from "./types";
import type { ImportRepository, StagingRowInput, ValidationSummary } from "./repository";
import type { ColumnMapping, ImportType, ProposedAction } from "./types";

export interface ImportPipelineDeps {
  repository: ImportRepository;
}

export type UploadStageResult =
  | {
      ok: true; needsSheetSelection: true; sheetNames: string[];
      sheetPreviews: Record<string, { headers: string[]; previewRows: string[][] }>;
    }
  | {
      ok: true; needsSheetSelection: false; batchId: string; headers: string[];
      suggestedMapping: ColumnMapping[]; previewRows: string[][]; totalRows: number; selectedSheet: string;
    }
  | { ok: false; error: string };

function simpleHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Upload satu file (CSV atau XLSX). Jika XLSX punya >1 sheet dan `sheetName`
 * tidak diberikan, TIDAK ADA batch yang dibuat -- hanya daftar nama sheet +
 * preview per-sheet yang dikembalikan (LANGKAH C: admin harus memilih,
 * tidak pernah digabung otomatis). Client mengirim ulang file yang SAMA
 * (masih dipegang browser) beserta `sheetName` untuk benar-benar staging.
 */
export async function stageUploadedFile(
  deps: ImportPipelineDeps,
  input: {
    companyId: string; actorId: string; importType: ImportType; sourceSystem: string;
    filename: string; fileBytes: Uint8Array; sheetName?: string;
  }
): Promise<UploadStageResult> {
  const safeName = sanitizeFilename(input.filename);
  if (!input.sourceSystem.trim()) return { ok: false, error: "Sistem sumber (source system) wajib diisi." };

  const parsed = await parseImportFile(safeName, input.fileBytes);
  if (!parsed.ok) return { ok: false, error: parsed.reason };

  const { sheets } = parsed.workbook;

  let chosenSheet = sheets[0]!;
  if (sheets.length > 1) {
    if (!input.sheetName) {
      const sheetPreviews: Record<string, { headers: string[]; previewRows: string[][] }> = {};
      for (const s of sheets) sheetPreviews[s.name] = { headers: s.headers, previewRows: s.rows.slice(0, 5) };
      return { ok: true, needsSheetSelection: true, sheetNames: sheets.map((s) => s.name), sheetPreviews };
    }
    const match = sheets.find((s) => s.name === input.sheetName);
    if (!match) return { ok: false, error: `Sheet "${input.sheetName}" tidak ditemukan.` };
    chosenSheet = match;
  }

  const { headers, rows } = chosenSheet;
  if (headers.length === 0) return { ok: false, error: "Sheet tidak memiliki header/kolom yang bisa dibaca." };

  const rowCheck = checkRowCount(rows.length);
  if (!rowCheck.ok) return { ok: false, error: rowCheck.reason! };
  if (rows.length === 0) return { ok: false, error: "Sheet tidak memiliki baris data." };

  const fileHash = await sha256Hex(input.fileBytes);

  const { batchId } = await deps.repository.createBatch({
    companyId: input.companyId, importType: input.importType, sourceSystem: input.sourceSystem.trim(),
    originalFilename: safeName, fileHash, createdBy: input.actorId,
  });

  const stagingRows: StagingRowInput[] = rows.map((cells, idx) => {
    const rawData: Record<string, string> = {};
    headers.forEach((h, i) => { rawData[h] = cells[i] ?? ""; });
    return {
      rowNumber: idx + 1, rawData, normalizedData: {}, validationStatus: "ERROR",
      errors: [], warnings: [], detectedExistingId: null, proposedAction: "NEEDS_REVIEW",
      rowHash: simpleHash(JSON.stringify(rawData)),
    };
  });
  await deps.repository.replaceStagingRows(input.companyId, batchId, stagingRows);

  const suggestedMapping = coreSuggestMapping(headers, DOMAIN_FIELDS[input.importType]);

  return {
    ok: true, needsSheetSelection: false, batchId, headers, suggestedMapping,
    previewRows: rows.slice(0, 50), totalRows: rows.length, selectedSheet: chosenSheet.name,
  };
}

export type ValidateResult =
  | { ok: true; summary: ValidationSummary }
  | { ok: false; error: string };

export async function validateStagedBatch(
  deps: ImportPipelineDeps,
  input: { companyId: string; batchId: string; columnMappings: ColumnMapping[] }
): Promise<ValidateResult> {
  const batch = await deps.repository.getBatch(input.companyId, input.batchId);
  if (!batch) return { ok: false, error: "Batch tidak ditemukan." };
  if (batch.totalRows > MAX_IMPORT_ROWS) return { ok: false, error: "Jumlah baris melebihi batas." };

  const completeness = coreValidateMappingCompleteness(input.columnMappings, DOMAIN_FIELDS[batch.importType]);
  if (!completeness.ok) {
    return { ok: false, error: `Mapping belum lengkap. Field wajib belum dipetakan: ${completeness.missingRequiredFields.join(", ")}` };
  }

  await deps.repository.saveMapping(input.companyId, input.batchId, input.columnMappings);

  const stagedRows = await deps.repository.getBatchRows(input.companyId, input.batchId);
  const mapRow = (rawData: Record<string, string>): Record<string, string> => {
    const mapped: Record<string, string> = {};
    for (const m of input.columnMappings) mapped[m.targetField] = rawData[m.sourceColumn] ?? "";
    return mapped;
  };

  const seenLegacyKeys = new Set<string>();
  const dedupeKeyField: Record<ImportType, string | null> = {
    CUSTOMER_PIC: null, // toko boleh berulang lintas baris (multi-PIC) -- ditangani commit RPC.
    PRODUCT_PRICE: "product_legacy_code",
    OPEN_AR: "legacy_invoice_number",
    OPEN_ORDER: "legacy_order_number",
    HISTORICAL_ORDER: "legacy_order_number",
  };
  const dedupeField = dedupeKeyField[batch.importType];

  const results: StagingRowInput[] = [];
  let validCount = 0, warningCount = 0, errorCount = 0, duplicateCount = 0;
  const arReconciliationInputs: { rawOutstandingBalance: string; proposedAction: ProposedAction; normalizedOutstandingBalance: number | null }[] = [];

  for (const row of stagedRows) {
    const mapped = mapRow(row.rawData);

    // XLSX formula cell yang KEBETULAN dipetakan ke field data -- ditolak
    // eksplisit di sini, sebelum masuk ke validator domain manapun. Formula
    // TIDAK PERNAH dieksekusi/diambil hasil cache-nya (lihat
    // core/parsing/xlsx.ts).
    const formulaFields = Object.entries(mapped).filter(([, v]) => v === XLSX_FORMULA_CELL_MARKER).map(([k]) => k);
    if (formulaFields.length > 0) {
      results.push({
        rowNumber: row.rowNumber, rawData: row.rawData, normalizedData: {}, validationStatus: "ERROR",
        errors: formulaFields.map((f) => ({ field: f, message: "Cell berisi formula -- tidak diterima untuk data import." })),
        warnings: [], detectedExistingId: null, proposedAction: "NEEDS_REVIEW", rowHash: row.rowHash,
      });
      errorCount++;
      continue;
    }

    let result;
    if (batch.importType === "CUSTOMER_PIC") result = await validateCustomerPicRow(mapped, input.companyId, batch.sourceSystem, deps.repository);
    else if (batch.importType === "PRODUCT_PRICE") result = await validateProductPriceRow(mapped, input.companyId, batch.sourceSystem, deps.repository);
    else if (batch.importType === "OPEN_AR") result = await validateOpenArRow(mapped, input.companyId, batch.sourceSystem, deps.repository);
    else result = await validateOrderRow(mapped, input.companyId, batch.sourceSystem, deps.repository, batch.importType);

    const { errors, detectedExistingId, normalizedData } = result;
    let { validationStatus, proposedAction, warnings } = result;

    if (dedupeField && proposedAction === "CREATE") {
      const key = mapped[dedupeField]?.trim();
      if (key) {
        if (seenLegacyKeys.has(key)) {
          proposedAction = "SKIP_DUPLICATE";
          validationStatus = "DUPLICATE";
          warnings = [...warnings, { field: dedupeField, message: "Duplikat di dalam file yang sama -- kemunculan pertama yang dipakai." }];
        } else {
          seenLegacyKeys.add(key);
        }
      }
    }

    if (validationStatus === "VALID") validCount++;
    else if (validationStatus === "WARNING") warningCount++;
    else if (validationStatus === "DUPLICATE") duplicateCount++;
    else errorCount++;

    if (batch.importType === "OPEN_AR") {
      arReconciliationInputs.push({
        rawOutstandingBalance: mapped.outstanding_balance ?? "",
        proposedAction, normalizedOutstandingBalance: (normalizedData.outstanding_balance as number | null) ?? null,
      });
    }

    results.push({
      rowNumber: row.rowNumber, rawData: row.rawData, normalizedData,
      validationStatus, errors, warnings, detectedExistingId, proposedAction, rowHash: row.rowHash,
    });
  }

  await deps.repository.replaceStagingRows(input.companyId, input.batchId, results);

  let reconciliation: ValidationSummary["reconciliation"] = {};
  let readyToCommit = errorCount === 0 && (validCount + warningCount) > 0;

  if (batch.importType === "OPEN_AR") {
    const recon = computeArReconciliation(arReconciliationInputs);
    reconciliation = recon;
    readyToCommit = readyToCommit && recon.withinTolerance;
  }

  const summary: ValidationSummary = {
    totalRows: stagedRows.length, validRows: validCount, warningRows: warningCount,
    errorRows: errorCount, duplicateRows: duplicateCount, reconciliation, readyToCommit,
  };
  await deps.repository.applyValidationSummary(input.companyId, input.batchId, summary);

  return { ok: true, summary };
}
