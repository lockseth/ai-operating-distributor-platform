// =============================================================================
// Universal Data Onboarding Core — kontrak ImportDomainAdapter. Core hanya
// mendefinisikan BENTUK kontrak ini; core TIDAK PERNAH mengimpor adapter
// konkret (AODP atau lainnya) -- dependency selalu satu arah:
//
//   AODP adapter (lib/imports/*) --> Universal Core (lib/data-onboarding/core/*)
//
// commitBatch/rollbackBatch sengaja dibiarkan generik atas TCommitResult
// karena transaksinya biasanya didelegasikan ke RPC/repository milik
// masing-masing platform (AODP: Postgres RPC commit_import_batch/
// rollback_import_batch) -- core tidak berasumsi soal storage/DB apa pun.
// =============================================================================

import type {
  ColumnMapping, FieldDefinition, ReconciliationSummary, RowValidationResult,
} from "./types";
import { suggestColumnMapping } from "./mapping";

export interface ImportDomainAdapter<
  TValidateContext = unknown,
  TCommitResult = unknown,
  TRollbackResult = unknown,
> {
  readonly domain: string;

  canonicalColumns(): readonly FieldDefinition[];

  /** Default: alias-matching generik dari core. Adapter boleh override kalau perlu heuristik tambahan. */
  suggestMapping(sourceHeaders: readonly string[]): ColumnMapping[];

  /** Normalisasi + validasi + duplicate detection satu baris (AODP-specific lookup ada di dalam TValidateContext). */
  validateRow(mappedRow: Record<string, string>, context: TValidateContext): Promise<RowValidationResult>;

  /** Reconciliation agregat batch (opsional -- hanya domain finansial seperti OPEN_AR yang butuh). */
  reconcileBatch?(rows: readonly RowValidationResult[]): ReconciliationSummary;

  commitBatch(batchId: string, actorId: string): Promise<TCommitResult>;
  rollbackBatch(batchId: string, actorId: string, reason: string): Promise<TRollbackResult>;
}

/** Helper default untuk adapter yang cukup pakai mapping generik core apa adanya. */
export function defaultSuggestMapping(fields: readonly FieldDefinition[]) {
  return (sourceHeaders: readonly string[]): ColumnMapping[] => suggestColumnMapping(sourceHeaders, fields);
}
