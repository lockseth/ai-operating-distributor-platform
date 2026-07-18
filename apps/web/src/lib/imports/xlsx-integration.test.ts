import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { stageUploadedFile, validateStagedBatch } from "./service";
import { InMemoryImportRepository } from "./repository";
import { DOMAIN_FIELDS, type ColumnMapping, type ImportType } from "./types";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

function makeRepo() {
  return new InMemoryImportRepository();
}

function seedBaseline(repo: InMemoryImportRepository) {
  repo.seedUser({ id: OWNER_A, companyId: COMPANY_A, fullName: "Owner A", role: "owner", isActive: true });
  repo.seedUser({ id: OWNER_B, companyId: COMPANY_B, fullName: "Owner B", role: "owner", isActive: true });
}

function identityMapping(type: ImportType): ColumnMapping[] {
  return DOMAIN_FIELDS[type].map((f) => ({ sourceColumn: f.key, targetField: f.key }));
}

async function buildXlsxBytes(sheets: { name: string; headers: string[]; rows: string[][] }[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow(s.headers);
    for (const row of s.rows) ws.addRow(row);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function buildCsvBytes(headers: string[], rows: string[][]): Uint8Array {
  const esc = (v: string) => (v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v);
  const text = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  return new TextEncoder().encode(text);
}

describe("LANGKAH H -- Integrasi XLSX end-to-end lewat pipeline import yang sama dengan CSV", () => {
  it("XLSX satu sheet berhasil di-upload dan di-staging (tidak butuh pemilihan sheet)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const row = ["TK-001", "Toko Satu", "081200001111", "Jl. A", "Jakarta Selatan", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"];
    const bytes = await buildXlsxBytes([{ name: "Data", headers, rows: [row] }]);

    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT XLSX",
      filename: "toko.xlsx", fileBytes: bytes,
    });
    expect(upload.ok).toBe(true);
    if (!upload.ok || upload.needsSheetSelection) throw new Error("upload gagal atau butuh sheet selection tak terduga");
    expect(upload.totalRows).toBe(1);
    expect(upload.headers).toEqual(headers);
  });

  it("XLSX dengan >1 sheet mengembalikan needsSheetSelection=true TANPA membuat batch, lalu berhasil staging setelah sheet dipilih", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const row = ["TK-001", "Toko Satu", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"];
    const bytes = await buildXlsxBytes([
      { name: "Toko", headers, rows: [row] },
      { name: "Catatan Lain", headers: ["keterangan"], rows: [["tidak relevan"]] },
    ]);

    const first = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT XLSX",
      filename: "multi.xlsx", fileBytes: bytes,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.needsSheetSelection) throw new Error("harusnya butuh sheet selection");
    expect(first.sheetNames).toEqual(["Toko", "Catatan Lain"]);
    expect((await repo.listBatches(COMPANY_A))).toHaveLength(0); // belum ada batch dibuat

    const second = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT XLSX",
      filename: "multi.xlsx", fileBytes: bytes, sheetName: "Toko",
    });
    expect(second.ok).toBe(true);
    if (!second.ok || second.needsSheetSelection) throw new Error("upload kedua harusnya berhasil staging");
    expect(second.selectedSheet).toBe("Toko");
    expect(second.totalRows).toBe(1);
    expect((await repo.listBatches(COMPANY_A))).toHaveLength(1); // sheet lain TIDAK ikut ter-staging/gabung
  });

  it("CSV dan XLSX dengan data identik menghasilkan normalizedData yang SAMA PERSIS setelah validasi", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const row = ["TK-100", "Toko Kembar", "081200005555", "Jl. Kembar", "Bandung", "", "PIC Kembar", "081200006666", "kembar@example.com", "OWNER,RECEIVER", "TRUE"];

    const csvUpload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT Parity",
      filename: "toko.csv", fileBytes: buildCsvBytes(headers, [row]),
    });
    if (!csvUpload.ok || csvUpload.needsSheetSelection) throw new Error("csv upload gagal");
    await validateStagedBatch({ repository: repo }, { companyId: COMPANY_A, batchId: csvUpload.batchId, columnMappings: identityMapping("CUSTOMER_PIC") });
    const csvRows = await repo.getBatchRows(COMPANY_A, csvUpload.batchId);

    const xlsxUpload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT Parity",
      filename: "toko.xlsx", fileBytes: await buildXlsxBytes([{ name: "Data", headers, rows: [row] }]),
    });
    if (!xlsxUpload.ok || xlsxUpload.needsSheetSelection) throw new Error("xlsx upload gagal");
    await validateStagedBatch({ repository: repo }, { companyId: COMPANY_A, batchId: xlsxUpload.batchId, columnMappings: identityMapping("CUSTOMER_PIC") });
    const xlsxRows = await repo.getBatchRows(COMPANY_A, xlsxUpload.batchId);

    expect(xlsxRows[0]!.normalizedData).toEqual(csvRows[0]!.normalizedData);
    expect(xlsxRows[0]!.proposedAction).toBe(csvRows[0]!.proposedAction);
    expect(xlsxRows[0]!.validationStatus).toBe(csvRows[0]!.validationStatus);
  });

  it("cell formula XLSX pada field yang DIPETAKAN ditolak eksplisit (ERROR, bukan diam-diam dilewati)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(headers);
    const dataRow = ws.addRow(["TK-200", "Toko Formula", "", "", "", "", "PIC X", "081200007777", "", "OWNER", "TRUE"]);
    // store_name (kolom ke-2) DI BARIS DATA YANG SAMA diganti formula (bukan baris baru terpisah).
    dataRow.getCell(2).value = { formula: "CONCATENATE(\"Toko \",\"Formula\")", result: "Toko Formula" } as ExcelJS.CellFormulaValue;
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());

    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT Formula",
      filename: "formula.xlsx", fileBytes: bytes,
    });
    if (!upload.ok || upload.needsSheetSelection) throw new Error("upload gagal");
    const validate = await validateStagedBatch({ repository: repo }, { companyId: COMPANY_A, batchId: upload.batchId, columnMappings: identityMapping("CUSTOMER_PIC") });
    expect(validate.ok).toBe(true);
    if (!validate.ok) return;
    expect(validate.summary.errorRows).toBe(1);

    const rows = await repo.getBatchRows(COMPANY_A, upload.batchId);
    expect(rows[0]!.validationStatus).toBe("ERROR");
    expect(rows[0]!.proposedAction).toBe("NEEDS_REVIEW");
    expect(rows[0]!.errors.some((e) => e.field === "store_name" && e.message.includes("formula"))).toBe(true);
  });

  it("batch XLSX bisa di-commit, retry commit kedua idempotent (already_committed, bukan data ganda)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const row = ["PRD-XLSX-1", "SKU-XLSX-1", "Produk XLSX", "dus", "50000", "TRUE"];
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "PRODUCT_PRICE", sourceSystem: "UAT Idempotent",
      filename: "produk.xlsx", fileBytes: await buildXlsxBytes([{ name: "Data", headers, rows: [row] }]),
    });
    if (!upload.ok || upload.needsSheetSelection) throw new Error("upload gagal");
    await validateStagedBatch({ repository: repo }, { companyId: COMPANY_A, batchId: upload.batchId, columnMappings: identityMapping("PRODUCT_PRICE") });

    const first = await repo.commitBatch(COMPANY_A, upload.batchId, OWNER_A);
    const second = await repo.commitBatch(COMPANY_A, upload.batchId, OWNER_A);
    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("already_committed");
    expect(repo.totalProducts()).toBe(1); // retry tidak menggandakan data
  });

  it("batch berasal dari XLSX tetap tunduk pada isolasi tenant -- company lain tidak bisa akses/commit", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const row = ["PRD-XLSX-2", "SKU-XLSX-2", "Produk XLSX B", "dus", "60000", "TRUE"];
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "PRODUCT_PRICE", sourceSystem: "UAT Tenant",
      filename: "produk.xlsx", fileBytes: await buildXlsxBytes([{ name: "Data", headers, rows: [row] }]),
    });
    if (!upload.ok || upload.needsSheetSelection) throw new Error("upload gagal");

    // Company B tidak melihat batch ini sama sekali (lookup gagal total -- tidak bocor "ada tapi tidak boleh").
    const batchFromB = await repo.getBatch(COMPANY_B, upload.batchId);
    expect(batchFromB).toBeNull();

    const commitFromB = await repo.commitBatch(COMPANY_B, upload.batchId, OWNER_B);
    expect(commitFromB.outcome).toBe("not_found");

    // Skenario forbidden yang berbeda: companyId param benar (milik batch), tapi actor-nya dari company lain.
    const commitWrongActor = await repo.commitBatch(COMPANY_A, upload.batchId, OWNER_B);
    expect(commitWrongActor.outcome).toBe("forbidden");
  });
});
