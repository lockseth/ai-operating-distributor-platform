// =============================================================================
// Universal Data Onboarding Core — status label user-facing (LANGKAH UX
// correction). Enum internal (mis. "VALIDATED") TIDAK PERNAH ditampilkan
// langsung ke pengguna -- diturunkan dari data batch yang SUDAH ADA
// (status/errorRows/warningRows/reconciliation), bukan kolom/migration baru.
//
// "VALIDATED" secara internal berarti "proses validasi sudah dijalankan",
// BUKAN "data valid". Kalau errorCount>0 atau reconciliation tidak seimbang,
// status internalnya tetap "VALIDATED" (bukan "READY_TO_COMMIT") -- label
// user-facing di bawah ini yang membedakan makna sebenarnya, tanpa mengubah
// state machine/enum database sama sekali.
// =============================================================================

import type { ImportBatchStatus, ReconciliationSummary } from "./types";

export type ImportStatusTone = "neutral" | "error" | "warning" | "success";

export interface ImportStatusLabelInput {
  status: ImportBatchStatus;
  errorRows: number;
  warningRows: number;
  reconciliation: ReconciliationSummary | Record<string, never>;
}

export interface ImportStatusLabelResult {
  label: string;
  tone: ImportStatusTone;
}

function isReconciliationMismatch(reconciliation: ReconciliationSummary | Record<string, never>): boolean {
  return "withinTolerance" in reconciliation && reconciliation.withinTolerance === false;
}

export function deriveImportStatusLabel(input: ImportStatusLabelInput): ImportStatusLabelResult {
  if (input.status === "ROLLED_BACK") return { label: "ROLLBACK SELESAI", tone: "neutral" };
  if (input.status === "COMMITTED") return { label: "SELESAI DI-IMPORT", tone: "success" };
  if (input.status === "UPLOADED" || input.status === "MAPPED") return { label: "BELUM DIVALIDASI", tone: "neutral" };

  // Di sini status internal adalah VALIDATED, READY_TO_COMMIT, atau FAILED --
  // TIDAK PERNAH dipakai langsung sebagai label. FAILED (commit gagal
  // dieksekusi) diperlakukan sama dengan "perlu diperbaiki" karena admin
  // harus meninjau ulang sebelum retry (tombol "Coba Commit Lagi" tetap ada).
  if (input.status === "FAILED" || input.errorRows > 0 || isReconciliationMismatch(input.reconciliation)) {
    return { label: "PERLU DIPERBAIKI", tone: "error" };
  }
  if (input.warningRows > 0) {
    return { label: "SIAP DITINJAU", tone: "warning" };
  }
  return { label: "SIAP DI-COMMIT", tone: "success" };
}

export const IMPORT_STATUS_TONE_CLASSES: Record<ImportStatusTone, string> = {
  neutral: "bg-gray-100 text-gray-600",
  error: "bg-red-50 text-red-700",
  warning: "bg-amber-50 text-amber-700",
  success: "bg-green-50 text-green-700",
};
