// =============================================================================
// print-capacity.ts test -- membuktikan konstanta kapasitas panel terukur
// nyata. LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE": kapasitas ini
// TIDAK LAGI dipakai untuk menolak transaksi (assertPanelCapacity/
// PanelCapacityExceededError DIHAPUS) -- sekarang murni parameter pagination
// (lihat print-pagination.test.ts untuk pembuktian continuation).
// =============================================================================

import { describe, expect, it } from "vitest";
import { MAX_ITEM_ROWS_PER_PANEL } from "./print-capacity";

describe("MAX_ITEM_ROWS_PER_PANEL", () => {
  it("terkunci pada 10 -- diukur nyata dari worst-case layout (lihat komentar print-capacity.ts)", () => {
    expect(MAX_ITEM_ROWS_PER_PANEL).toBe(10);
  });
});
