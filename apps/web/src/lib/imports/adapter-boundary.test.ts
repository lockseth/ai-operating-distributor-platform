// =============================================================================
// TEST TAMBAHAN (addendum) -- sisi AODP dari boundary Universal Core: dua
// domain AODP berbeda (CUSTOMER_PIC, OPEN_AR) memakai MESIN yang sama
// (suggestColumnMapping/validateMappingCompleteness generik core, plus
// stageUploadedFile/validateStagedBatch di service.ts), dan mapping domain
// yang SALAH ditolak sebelum bisa divalidasi. Lihat juga
// core/adapter-boundary.test.ts untuk sisi core (fake non-AODP adapter).
// =============================================================================

import { describe, it, expect } from "vitest";
import { suggestColumnMapping, validateMappingCompleteness } from "@/lib/data-onboarding/core/mapping";
import { stageUploadedFile, validateStagedBatch } from "./service";
import { InMemoryImportRepository } from "./repository";
import { DOMAIN_FIELDS } from "./types";

const COMPANY_A = "company-a";
const OWNER_A = "owner-a";

function makeRepo() {
  const repo = new InMemoryImportRepository();
  repo.seedUser({ id: OWNER_A, companyId: COMPANY_A, fullName: "Owner A", role: "owner", isActive: true });
  return repo;
}

function buildCsv(headers: string[], rows: string[][]): Uint8Array {
  const esc = (v: string) => (v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v);
  const text = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  return new TextEncoder().encode(text);
}

describe("Dua domain adapter AODP berbeda memakai mesin batch (Universal Core primitives) yang sama", () => {
  it("suggestColumnMapping generik core dipakai berhasil untuk CUSTOMER_PIC dan OPEN_AR sekaligus, tanpa saling mengganggu", () => {
    const picMapping = suggestColumnMapping(["Nama Toko"], DOMAIN_FIELDS.CUSTOMER_PIC);
    const arMapping = suggestColumnMapping(["Nomor Invoice Lama"], DOMAIN_FIELDS.OPEN_AR);
    expect(picMapping.find((m) => m.sourceColumn === "Nama Toko")?.targetField).toBe("store_name");
    expect(arMapping.find((m) => m.sourceColumn === "Nomor Invoice Lama")?.targetField).toBe("legacy_invoice_number");
  });

  it("stageUploadedFile+validateStagedBatch (mesin yang sama persis) berhasil memproses batch CUSTOMER_PIC dan PRODUCT_PRICE secara berurutan dalam satu repository", async () => {
    const repo = makeRepo();

    const picHeaders = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const picUpload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT",
      filename: "toko.csv", fileBytes: buildCsv(picHeaders, [["TK-1", "Toko Satu", "", "", "", "", "PIC A", "081200001111", "", "OWNER", "TRUE"]]),
    });
    if (!picUpload.ok || picUpload.needsSheetSelection) throw new Error("pic upload gagal");
    const picValidate = await validateStagedBatch({ repository: repo }, {
      companyId: COMPANY_A, batchId: picUpload.batchId, columnMappings: picHeaders.map((k) => ({ sourceColumn: k, targetField: k })),
    });
    expect(picValidate.ok).toBe(true);

    const productHeaders = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const productUpload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "PRODUCT_PRICE", sourceSystem: "UAT",
      filename: "produk.csv", fileBytes: buildCsv(productHeaders, [["PRD-1", "SKU-1", "Produk A", "dus", "10000", "TRUE"]]),
    });
    if (!productUpload.ok || productUpload.needsSheetSelection) throw new Error("product upload gagal");
    const productValidate = await validateStagedBatch({ repository: repo }, {
      companyId: COMPANY_A, batchId: productUpload.batchId, columnMappings: productHeaders.map((k) => ({ sourceColumn: k, targetField: k })),
    });
    expect(productValidate.ok).toBe(true);

    // Kedua batch (domain berbeda) hidup berdampingan di repository yang sama, diproses mesin yang sama.
    const batches = await repo.listBatches(COMPANY_A);
    expect(batches.map((b) => b.importType).sort()).toEqual(["CUSTOMER_PIC", "PRODUCT_PRICE"]);
  });

  it("wrong-domain: mapping CUSTOMER_PIC dipaksakan untuk batch OPEN_AR ditolak (field wajib OPEN_AR tidak terpenuhi)", async () => {
    const wrongMapping = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => ({ sourceColumn: f.key, targetField: f.key }));
    const completeness = validateMappingCompleteness(wrongMapping, DOMAIN_FIELDS.OPEN_AR);
    expect(completeness.ok).toBe(false);
    expect(completeness.missingRequiredFields).toContain("legacy_invoice_number");
  });

  it("wrong-domain end-to-end: validateStagedBatch batch OPEN_AR dengan mapping CUSTOMER_PIC ditolak sebelum staging rows tersentuh", async () => {
    const repo = makeRepo();
    const arHeaders = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "OPEN_AR", sourceSystem: "UAT",
      filename: "ar.csv", fileBytes: buildCsv(arHeaders, [arHeaders.map(() => "x")]),
    });
    if (!upload.ok || upload.needsSheetSelection) throw new Error("upload gagal");

    const wrongMapping = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => ({ sourceColumn: f.key, targetField: f.key }));
    const result = await validateStagedBatch({ repository: repo }, {
      companyId: COMPANY_A, batchId: upload.batchId, columnMappings: wrongMapping,
    });
    expect(result.ok).toBe(false);
  });
});
