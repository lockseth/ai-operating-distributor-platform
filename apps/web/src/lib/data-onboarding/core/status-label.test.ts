import { describe, it, expect } from "vitest";
import { deriveImportStatusLabel } from "./status-label";
import type { ReconciliationSummary } from "./types";

const BALANCED_RECON: ReconciliationSummary = {
  sourceTotal: 1000, importTotal: 1000, excludedTotal: 0, difference: 0, toleranceUsed: 0.01, withinTolerance: true,
};
const MISMATCH_RECON: ReconciliationSummary = {
  sourceTotal: 1000, importTotal: 900, excludedTotal: 0, difference: 100, toleranceUsed: 0.01, withinTolerance: false,
};

describe("deriveImportStatusLabel -- koreksi UX status Import Data (bukan enum internal)", () => {
  it("batch dengan error (errorRows > 0) -> PERLU DIPERBAIKI, walau status internal masih VALIDATED", () => {
    const result = deriveImportStatusLabel({ status: "VALIDATED", errorRows: 2, warningRows: 0, reconciliation: {} });
    expect(result.label).toBe("PERLU DIPERBAIKI");
    expect(result.tone).toBe("error");
  });

  it("reconciliation tidak seimbang -> PERLU DIPERBAIKI walau errorRows == 0", () => {
    const result = deriveImportStatusLabel({ status: "VALIDATED", errorRows: 0, warningRows: 0, reconciliation: MISMATCH_RECON });
    expect(result.label).toBe("PERLU DIPERBAIKI");
    expect(result.tone).toBe("error");
  });

  it("zero error + ada warning -> SIAP DITINJAU (warning tidak diam-diam dianggap fully valid)", () => {
    const result = deriveImportStatusLabel({ status: "READY_TO_COMMIT", errorRows: 0, warningRows: 3, reconciliation: {} });
    expect(result.label).toBe("SIAP DITINJAU");
    expect(result.tone).toBe("warning");
  });

  it("zero error + zero warning + reconciliation seimbang -> SIAP DI-COMMIT", () => {
    const result = deriveImportStatusLabel({ status: "READY_TO_COMMIT", errorRows: 0, warningRows: 0, reconciliation: BALANCED_RECON });
    expect(result.label).toBe("SIAP DI-COMMIT");
    expect(result.tone).toBe("success");
  });

  it("zero error + zero warning tanpa reconciliation (domain non-finansial) -> tetap SIAP DI-COMMIT", () => {
    const result = deriveImportStatusLabel({ status: "READY_TO_COMMIT", errorRows: 0, warningRows: 0, reconciliation: {} });
    expect(result.label).toBe("SIAP DI-COMMIT");
    expect(result.tone).toBe("success");
  });

  it("batch COMMITTED -> SELESAI DI-IMPORT", () => {
    const result = deriveImportStatusLabel({ status: "COMMITTED", errorRows: 0, warningRows: 0, reconciliation: BALANCED_RECON });
    expect(result.label).toBe("SELESAI DI-IMPORT");
    expect(result.tone).toBe("success");
  });

  it("batch ROLLED_BACK -> ROLLBACK SELESAI", () => {
    const result = deriveImportStatusLabel({ status: "ROLLED_BACK", errorRows: 0, warningRows: 0, reconciliation: {} });
    expect(result.label).toBe("ROLLBACK SELESAI");
    expect(result.tone).toBe("neutral");
  });

  it("status FAILED (commit gagal dieksekusi) -> PERLU DIPERBAIKI, tidak pernah SELESAI DI-IMPORT", () => {
    const result = deriveImportStatusLabel({ status: "FAILED", errorRows: 0, warningRows: 0, reconciliation: BALANCED_RECON });
    expect(result.label).toBe("PERLU DIPERBAIKI");
  });

  it("batch belum divalidasi (UPLOADED/MAPPED) tidak pernah diberi label sukses", () => {
    expect(deriveImportStatusLabel({ status: "UPLOADED", errorRows: 0, warningRows: 0, reconciliation: {} }).label).toBe("BELUM DIVALIDASI");
    expect(deriveImportStatusLabel({ status: "MAPPED", errorRows: 0, warningRows: 0, reconciliation: {} }).label).toBe("BELUM DIVALIDASI");
  });

  it("kondisi error TIDAK PERNAH menghasilkan label mentah 'VALIDATED' -- ini inti perbaikan UX", () => {
    const scenarios: Array<Parameters<typeof deriveImportStatusLabel>[0]> = [
      { status: "VALIDATED", errorRows: 5, warningRows: 0, reconciliation: {} },
      { status: "VALIDATED", errorRows: 0, warningRows: 0, reconciliation: MISMATCH_RECON },
      { status: "VALIDATED", errorRows: 1, warningRows: 2, reconciliation: MISMATCH_RECON },
    ];
    for (const s of scenarios) {
      const result = deriveImportStatusLabel(s);
      expect(result.label).not.toBe("VALIDATED");
      expect(result.label).toBe("PERLU DIPERBAIKI");
    }
  });
});
