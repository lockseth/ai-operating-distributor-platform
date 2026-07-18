// =============================================================================
// AR reconciliation (LANGKAH 9). Dua lapis:
//  1. Per-baris: original_amount - amount_paid = outstanding_balance, dengan
//     toleransi (dicek di validators.ts::validateOpenArRow, per baris).
//  2. Agregat batch (di sini): total outstanding SELURUH file sumber harus
//     habis dijelaskan oleh (baris yang akan diimport) + (baris yang sengaja
//     dikecualikan -- duplicate/needs-review). Kalau ada selisih yang tidak
//     bisa dijelaskan, itu tanda ada baris yang "hilang" secara diam-diam --
//     batch tidak boleh READY_TO_COMMIT.
// =============================================================================

import { normalizeIdCurrency } from "./normalize";
import type { ProposedAction, ReconciliationSummary } from "./types";

export interface ArReconciliationRowInput {
  rawOutstandingBalance: string;
  proposedAction: ProposedAction;
  normalizedOutstandingBalance: number | null;
}

const DEFAULT_TOLERANCE_RUPIAH = 1;

export function computeArReconciliation(
  rows: readonly ArReconciliationRowInput[],
  toleranceRupiah = DEFAULT_TOLERANCE_RUPIAH
): ReconciliationSummary {
  let sourceTotal = 0;
  let importTotal = 0;
  let excludedTotal = 0;

  for (const row of rows) {
    const sourceValue = normalizeIdCurrency(row.rawOutstandingBalance) ?? 0;
    sourceTotal += sourceValue;

    if (row.proposedAction === "CREATE" || row.proposedAction === "UPDATE") {
      importTotal += row.normalizedOutstandingBalance ?? 0;
    } else {
      excludedTotal += sourceValue;
    }
  }

  sourceTotal = Number(sourceTotal.toFixed(2));
  importTotal = Number(importTotal.toFixed(2));
  excludedTotal = Number(excludedTotal.toFixed(2));
  const difference = Number((sourceTotal - importTotal - excludedTotal).toFixed(2));

  return {
    sourceTotal, importTotal, excludedTotal, difference,
    toleranceUsed: toleranceRupiah,
    withinTolerance: Math.abs(difference) <= toleranceRupiah,
  };
}
