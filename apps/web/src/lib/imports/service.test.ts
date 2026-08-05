import { describe, it, expect } from "vitest";
import { stageUploadedFile, validateStagedBatch } from "./service";
import { InMemoryImportRepository } from "./repository";
import { suggestColumnMapping, validateMappingCompleteness } from "./mapping";
import { DOMAIN_FIELDS, type ColumnMapping, type ImportType } from "./types";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const SALES_A = "sales-a";

function makeRepo() {
  return new InMemoryImportRepository();
}

function seedBaseline(repo: InMemoryImportRepository) {
  repo.seedUser({ id: OWNER_A, companyId: COMPANY_A, fullName: "Owner A", role: "owner", isActive: true });
  repo.seedUser({ id: SALES_A, companyId: COMPANY_A, fullName: "Budi Sales", role: "sales", isActive: true });
  repo.seedUser({ id: OWNER_B, companyId: COMPANY_B, fullName: "Owner B", role: "owner", isActive: true });
}

/** identity mapping = header sama persis dengan target field key (menghindari perlu suggest mapping di tiap test). */
function identityMapping(type: ImportType): ColumnMapping[] {
  return DOMAIN_FIELDS[type].map((f) => ({ sourceColumn: f.key, targetField: f.key }));
}

function buildCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) => (v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

function encodeCsv(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Upload sekali-jalan yang mengasumsikan CSV single-sheet (tidak pernah butuh sheet selection) -- lempar error kalau ternyata butuh (menandakan bug test, bukan fitur). */
async function uploadCsv(
  repo: InMemoryImportRepository, companyId: string, actorId: string, importType: ImportType,
  headers: string[], rows: string[][], filename = "data.csv"
) {
  const upload = await stageUploadedFile({ repository: repo }, {
    companyId, actorId, importType, sourceSystem: "UAT Legacy", filename,
    fileBytes: encodeCsv(buildCsv(headers, rows)),
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.error}`);
  if (upload.needsSheetSelection) throw new Error("unexpected sheet selection for single-sheet CSV");
  return upload;
}

async function uploadAndValidate(
  repo: InMemoryImportRepository, companyId: string, actorId: string, importType: ImportType,
  headers: string[], rows: string[][], mapping?: ColumnMapping[]
) {
  const upload = await uploadCsv(repo, companyId, actorId, importType, headers, rows);
  const validate = await validateStagedBatch({ repository: repo }, {
    companyId, batchId: upload.batchId, columnMappings: mapping ?? identityMapping(importType),
  });
  if (!validate.ok) throw new Error(`validate failed: ${validate.error}`);
  return { batchId: upload.batchId, summary: validate.summary };
}

describe("1. CSV valid berhasil diupload dan di-staging", () => {
  it("upload CSV CUSTOMER_PIC menghasilkan batch UPLOADED dengan baris ter-staging", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT Legacy",
      filename: "toko.csv",
      fileBytes: encodeCsv(buildCsv(headers, [["TK-001", "Toko Satu", "081200001111", "Jl. A", "Jakarta Selatan", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"]])),
    });
    expect(upload.ok).toBe(true);
    if (upload.ok && !upload.needsSheetSelection) {
      expect(upload.totalRows).toBe(1);
      expect(upload.headers).toEqual(headers);
      const batch = await repo.getBatch(COMPANY_A, upload.batchId);
      expect(batch?.status).toBe("UPLOADED");
    }
  });

  it("mapping suggestion mengenali alias kolom Indonesia (LANGKAH 6)", () => {
    const mapping = suggestColumnMapping(["Nama Outlet", "Nomor HP", "Sales TO"], "CUSTOMER_PIC");
    expect(mapping.find((m) => m.sourceColumn === "Nama Outlet")?.targetField).toBe("store_name");
    expect(mapping.find((m) => m.sourceColumn === "Nomor HP")?.targetField).toBe("store_phone");
    expect(mapping.find((m) => m.sourceColumn === "Sales TO")?.targetField).toBe("assigned_salesman_name");
  });
});

describe("5. Mapping wajib field diperiksa sebelum validasi", () => {
  it("validateMappingCompleteness menandai field wajib yang belum dipetakan", () => {
    const result = validateMappingCompleteness([{ sourceColumn: "x", targetField: "store_name" }], "CUSTOMER_PIC");
    expect(result.ok).toBe(false);
    expect(result.missingRequiredFields).toContain("store_legacy_code");
  });

  it("pic_name/pic_phone/pic_roles TIDAK wajib di-mapping (file master pelanggan ERP sering tanpa kolom PIC sama sekali)", () => {
    const result = validateMappingCompleteness(
      [
        { sourceColumn: "kode", targetField: "store_legacy_code" },
        { sourceColumn: "nama", targetField: "store_name" },
      ],
      "CUSTOMER_PIC"
    );
    expect(result.ok).toBe(true);
    expect(result.missingRequiredFields).not.toContain("pic_name");
    expect(result.missingRequiredFields).not.toContain("pic_phone");
    expect(result.missingRequiredFields).not.toContain("pic_roles");
  });

  it("validateStagedBatch menolak jika mapping tidak lengkap", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "CUSTOMER_PIC", sourceSystem: "UAT",
      filename: "x.csv", fileBytes: encodeCsv(buildCsv(["store_name"], [["Toko X"]])),
    });
    expect(upload.ok).toBe(true);
    if (!upload.ok || upload.needsSheetSelection) return;
    const result = await validateStagedBatch({ repository: repo }, {
      companyId: COMPANY_A, batchId: upload.batchId, columnMappings: [{ sourceColumn: "store_name", targetField: "store_name" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("7. Customer/PIC duplicate ditangani tanpa duplikat diam-diam", () => {
  it("PIC dengan nomor sama pada toko yang sama -> SKIP_DUPLICATE, bukan baris baru", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const row = ["TK-001", "Toko Satu", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"];

    const first = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [row]);
    const commit1 = await repo.commitBatch(COMPANY_A, first.batchId, OWNER_A);
    expect(commit1.outcome).toBe("committed");
    expect(repo.totalCustomers()).toBe(1);
    expect(repo.totalPics()).toBe(1);

    // Baris kedua: toko sama (legacy code sama), PIC dengan NOMOR SAMA -> harus SKIP_DUPLICATE.
    const second = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [row]);
    expect(second.summary.duplicateRows).toBe(1);
    const rows2 = await repo.getBatchRows(COMPANY_A, second.batchId);
    expect(rows2[0]?.proposedAction).toBe("SKIP_DUPLICATE");
  });

  it("PIC kedua dengan nomor BERBEDA pada toko yang sama -> berhasil ditambahkan (bukan duplicate)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const row1 = ["TK-001", "Toko Satu", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"];
    const row2 = ["TK-001", "Toko Satu", "", "", "", "", "PIC Dua", "081200003333", "", "RECEIVER", "TRUE"];

    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [row1, row2]);
    expect(staged.summary.validRows).toBe(2);
    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(commit.outcome).toBe("committed");
    expect(repo.totalCustomers()).toBe(1); // satu toko
    expect(repo.totalPics()).toBe(2); // dua PIC
  });
});

describe("E (LANGKAH addendum). Invariant: preview proposed-action count == commit result count", () => {
  it("batch campuran CREATE/CREATE(toko baru sama)/UPDATE/SKIP_DUPLICATE -- createdCount+updatedCount commit HARUS sama dengan jumlah baris CREATE/UPDATE di preview, bukan cosmetic", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);

    // Baseline: toko TK-001 sudah ada dengan satu PIC (via commit batch terpisah),
    // supaya baris D di bawah punya PIC existing yang benar-benar bisa di-skip.
    const baselineRow = ["TK-001", "Toko Satu", "", "", "", "", "PIC Lama", "081200002222", "", "OWNER", "TRUE"];
    const baseline = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [baselineRow]);
    const baselineCommit = await repo.commitBatch(COMPANY_A, baseline.batchId, OWNER_A);
    expect(baselineCommit.outcome).toBe("committed");

    // Baris A & B: toko TK-100 BARU, direferensikan DUA KALI dalam satu batch
    // (dalam-batch dedup -- LANGKAH E) dengan PIC berbeda -> masing-masing
    // baris independen divalidasi sebagai CREATE (validator tidak tahu baris
    // lain), tapi commit RPC hanya membuat SATU toko (baris kedua reuse toko
    // yang dibuat baris pertama). Invariant tetap: dihitung PER BARIS.
    const rowA = ["TK-100", "Toko Baru", "", "", "", "", "PIC A", "081300001111", "", "OWNER", "TRUE"];
    const rowB = ["TK-100", "Toko Baru", "", "", "", "", "PIC B", "081300002222", "", "RECEIVER", "TRUE"];
    // Baris C: toko existing (TK-001) + PIC baru -> UPDATE.
    const rowC = ["TK-001", "Toko Satu", "", "", "", "", "PIC C", "081300003333", "", "RECEIVER", "TRUE"];
    // Baris D: toko existing (TK-001) + PIC dengan nomor SAMA dengan baseline -> SKIP_DUPLICATE.
    const rowD = ["TK-001", "Toko Satu", "", "", "", "", "PIC Lama", "081200002222", "", "OWNER", "TRUE"];

    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [rowA, rowB, rowC, rowD]);
    const previewRows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    const previewCreateCount = previewRows.filter((r) => r.proposedAction === "CREATE").length;
    const previewUpdateCount = previewRows.filter((r) => r.proposedAction === "UPDATE").length;
    const previewSkipCount = previewRows.filter((r) => r.proposedAction === "SKIP_DUPLICATE").length;

    // Sanity: pastikan skenario campuran benar-benar tercapai sebelum menguji invariant-nya.
    expect(previewCreateCount).toBe(2); // rowA + rowB (toko sama, dihitung per baris)
    expect(previewUpdateCount).toBe(1); // rowC
    expect(previewSkipCount).toBe(1); // rowD

    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(commit.outcome).toBe("committed");
    const committedBatch = await repo.getBatch(COMPANY_A, staged.batchId);
    const commitResult = committedBatch?.commitResult as { createdCount?: number; updatedCount?: number };

    // Invariant inti (bukan kosmetik -- preview adalah bagian approval):
    // proposed-action count di preview HARUS SAMA dengan commit result.
    expect(commitResult.createdCount).toBe(previewCreateCount);
    expect(commitResult.updatedCount).toBe(previewUpdateCount);

    // Bukti tambahan bahwa dalam-batch dedup toko tetap benar secara entity
    // (hanya SATU toko baru dibuat meski 2 baris CREATE mereferensikannya).
    expect(repo.totalCustomers()).toBe(2); // TK-001 (baseline) + TK-100 (baru)
    expect(repo.totalPics()).toBe(4); // 1 baseline + PIC A + PIC B + PIC C (PIC D di-skip)
  });
});

describe("8. Product/SKU duplicate -> UPDATE, bukan baris ganda", () => {
  it("SKU yang sudah ada (dari legacy_id berbeda) ditandai UPDATE dengan warning, bukan CREATE ganda", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedProduct({ id: "prod-1", companyId: COMPANY_A, sku: "SBN-001", name: "Sabun Lama", unit: "dus", price: 40000, isActive: true, legacySourceSystem: null, legacyId: null });

    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-NEW", "SBN-001", "Sabun Baru", "dus", "45000", "TRUE"]]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.proposedAction).toBe("UPDATE");
    expect(rows[0]?.detectedExistingId).toBe("prod-1");

    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(repo.totalProducts()).toBe(1);
    expect(repo.getProductSync("prod-1")?.price).toBe(45000);
  });

  it("legacy_id yang sama pada import kedua -> UPDATE harga, tidak membuat produk baru", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const first = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);
    await repo.commitBatch(COMPANY_A, first.batchId, OWNER_A);
    expect(repo.totalProducts()).toBe(1);

    const second = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "42000", "TRUE"]]);
    await repo.commitBatch(COMPANY_A, second.batchId, OWNER_A);
    expect(repo.totalProducts()).toBe(1);
    const product = [...repo.products.values()][0];
    expect(product?.price).toBe(42000);
  });
});

describe("9. Order/invoice duplicate", () => {
  it("legacy_invoice_number yang sama DALAM SATU FILE -> baris kedua SKIP_DUPLICATE (in-batch dedup)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });

    const headers = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    const row = ["INV-001", "TK-001", "01/07/2026", "", "1000000", "0", "1000000", "", ""];
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "OPEN_AR", headers, [row, row]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.proposedAction).toBe("CREATE");
    expect(rows[1]?.proposedAction).toBe("SKIP_DUPLICATE");
  });

  it("legacy_order_number yang sudah pernah diimport sebelumnya -> SKIP_DUPLICATE, bukan order ganda", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });
    repo.seedProduct({ id: "prod-1", companyId: COMPANY_A, sku: "SBN-001", name: "Sabun", unit: "dus", price: 40000, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "PRD-001" });

    const headers = DOMAIN_FIELDS.HISTORICAL_ORDER.map((f) => f.key);
    const row = ["SO-001", "TK-001", "01/03/2025", "", "PRD-001", "10", "40000", "400000", "paid"];
    const first = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "HISTORICAL_ORDER", headers, [row]);
    await repo.commitBatch(COMPANY_A, first.batchId, OWNER_A);
    expect(repo.totalOrders()).toBe(1);

    const second = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "HISTORICAL_ORDER", headers, [row]);
    const rows2 = await repo.getBatchRows(COMPANY_A, second.batchId);
    expect(rows2[0]?.proposedAction).toBe("SKIP_DUPLICATE");
    await repo.commitBatch(COMPANY_A, second.batchId, OWNER_A);
    expect(repo.totalOrders()).toBe(1); // tidak bertambah
  });
});

describe("10. Cross-tenant access ditolak", () => {
  it("legacy_id company A tidak ditemukan oleh lookup company B (tidak ada kebocoran lintas tenant)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-a", companyId: COMPANY_A, name: "Toko A", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });

    const found = await repo.findCustomerByLegacyId(COMPANY_B, "UAT Legacy", "TK-001");
    expect(found).toBeNull();
    const foundOwn = await repo.findCustomerByLegacyId(COMPANY_A, "UAT Legacy", "TK-001");
    expect(foundOwn?.id).toBe("cust-a");
  });

  it("commitBatch/rollbackBatch dengan actor company lain ditolak (forbidden)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);

    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_B);
    expect(commit.outcome).toBe("forbidden");
  });

  it("Salesman (role sales) ditolak melakukan commit -- bulk import hanya admin/owner/manager", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);
    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, SALES_A);
    expect(commit.outcome).toBe("forbidden");
  });
});

describe("11. Legacy ID sama pada tenant BERBEDA tetap boleh (tidak saling mempengaruhi)", () => {
  it("dua company memakai legacy_id produk yang sama -> masing-masing berhasil dibuat sendiri-sendiri", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const row = ["PRD-SAME", "SBN-001", "Sabun", "dus", "40000", "TRUE"];

    const a = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [row]);
    const commitA = await repo.commitBatch(COMPANY_A, a.batchId, OWNER_A);
    expect(commitA.outcome).toBe("committed");

    const b = await uploadAndValidate(repo, COMPANY_B, OWNER_B, "PRODUCT_PRICE", headers, [row]);
    const commitB = await repo.commitBatch(COMPANY_B, b.batchId, OWNER_B);
    expect(commitB.outcome).toBe("committed");

    expect(repo.totalProducts()).toBe(2);
  });
});

describe("12. Retry batch idempotent", () => {
  it("commit dipanggil dua kali pada batch yang sama -> kedua kalinya already_committed, tidak membuat data ganda", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);

    const first = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    const second = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("already_committed");
    expect(repo.totalProducts()).toBe(1);
  });

  it("findCommittedBatchByHash mendeteksi file yang sama sudah pernah di-commit", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const upload = await stageUploadedFile({ repository: repo }, {
      companyId: COMPANY_A, actorId: OWNER_A, importType: "PRODUCT_PRICE", sourceSystem: "UAT",
      filename: "p.csv", fileBytes: encodeCsv(buildCsv(headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]])),
    });
    if (!upload.ok) throw new Error("upload failed");
    if (upload.needsSheetSelection) throw new Error("unexpected sheet selection");
    await validateStagedBatch({ repository: repo }, { companyId: COMPANY_A, batchId: upload.batchId, columnMappings: identityMapping("PRODUCT_PRICE") });
    await repo.commitBatch(COMPANY_A, upload.batchId, OWNER_A);

    const batch = await repo.getBatch(COMPANY_A, upload.batchId);
    const found = await repo.findCommittedBatchByHash(COMPANY_A, "PRODUCT_PRICE", batch!.fileHash);
    expect(found?.id).toBe(upload.batchId);
  });
});

describe("13/14. AR reconciliation per-baris dan agregat", () => {
  it("baris dengan original-paid TIDAK SAMA dengan outstanding -> ERROR, tidak bisa commit", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });

    const headers = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    // original 1.000.000 - paid 200.000 = 800.000, tapi outstanding ditulis 700.000 (salah).
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "OPEN_AR", headers, [["INV-001", "TK-001", "01/07/2026", "", "1000000", "200000", "700000", "", ""]]);
    expect(staged.summary.errorRows).toBe(1);
    expect(staged.summary.readyToCommit).toBe(false);
  });

  it("total outstanding sumber cocok dengan total yang akan diimport -> READY_TO_COMMIT", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });

    const headers = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "OPEN_AR", headers, [
      ["INV-001", "TK-001", "01/07/2026", "", "1000000", "200000", "800000", "", ""],
      ["INV-002", "TK-001", "02/07/2026", "", "500000", "0", "500000", "", ""],
    ]);
    expect(staged.summary.readyToCommit).toBe(true);
    const batch = await repo.getBatch(COMPANY_A, staged.batchId);
    const recon = batch?.reconciliation as { sourceTotal: number; importTotal: number; withinTolerance: boolean };
    expect(recon.withinTolerance).toBe(true);
    expect(recon.importTotal).toBe(1300000);
  });

  it("14. total mismatch (baris hilang/dikecualikan tanpa penjelasan) memblokir READY_TO_COMMIT", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });
    repo.seedCustomer({ id: "cust-2", companyId: COMPANY_A, name: "Toko Dua", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-002", importBatchId: null, lastOrderAt: null });

    const headers = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    // INV-002 merujuk toko yang TIDAK diimport (TK-999) -> ERROR, dikecualikan dari commit tapi tetap tercatat di reconciliation.
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "OPEN_AR", headers, [
      ["INV-001", "TK-001", "01/07/2026", "", "1000000", "0", "1000000", "", ""],
      ["INV-002", "TK-999", "02/07/2026", "", "500000", "0", "500000", "", ""],
    ]);
    expect(staged.summary.errorRows).toBe(1);
    // errorRows > 0 -> readyToCommit false (LANGKAH 9: error kritikal memblokir commit).
    expect(staged.summary.readyToCommit).toBe(false);
  });
});

describe("15. Partial failure tidak meninggalkan orphan", () => {
  it("commit yang gagal di tengah proses membuat batch FAILED, tidak ada entity yatim tertinggal", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.OPEN_AR.map((f) => f.key);
    // customer_id akan null (tidak ditemukan) tapi lolos ke normalizedData karena kita paksa lewat repository langsung
    // -- simulasikan kegagalan commit dengan customer_id yang sengaja tidak valid.
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "OPEN_AR", headers, [
      ["INV-001", "TK-001", "01/07/2026", "", "1000000", "0", "1000000", "", ""],
    ]);
    // Rusak normalizedData baris pertama secara paksa untuk mensimulasikan error runtime saat commit.
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    (rows[0]!.normalizedData as Record<string, unknown>).customer_id = undefined;
    await repo.replaceStagingRows(COMPANY_A, staged.batchId, rows.map((r) => ({
      rowNumber: r.rowNumber, rawData: r.rawData, normalizedData: r.normalizedData, validationStatus: r.validationStatus,
      errors: r.errors, warnings: r.warnings, detectedExistingId: r.detectedExistingId, proposedAction: r.proposedAction, rowHash: r.rowHash,
    })));

    const before = repo.totalAr();
    const result = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(result.outcome).toBe("failed");
    const batch = await repo.getBatch(COMPANY_A, staged.batchId);
    expect(batch?.status).toBe("FAILED");
    expect(repo.totalAr()).toBe(before); // tidak ada baris AR yatim yang tertinggal
  });
});

describe("16. Historical import tidak membuat dispatch/alert/achievement", () => {
  it("commit HISTORICAL_ORDER hanya menyentuh sales_orders + customers.last_order_at -- tidak ada dispatch/delivery/owner_alert yang dibuat", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    repo.seedCustomer({ id: "cust-1", companyId: COMPANY_A, name: "Toko Satu", phone: null, address: null, area: null, assignedSalesId: null, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "TK-001", importBatchId: null, lastOrderAt: null });
    repo.seedProduct({ id: "prod-1", companyId: COMPANY_A, sku: "SBN-001", name: "Sabun", unit: "dus", price: 40000, isActive: true, legacySourceSystem: "UAT Legacy", legacyId: "PRD-001" });

    const headers = DOMAIN_FIELDS.HISTORICAL_ORDER.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "HISTORICAL_ORDER", headers, [
      ["SO-001", "TK-001", "01/03/2025", "", "PRD-001", "10", "40000", "400000", "paid"],
    ]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);

    expect(repo.totalOrders()).toBe(1);
    expect(repo.deliveries.size).toBe(0); // tidak ada delivery/dispatch yang dibuat
    const customer = repo.getCustomerSync("cust-1");
    expect(customer?.lastOrderAt).toBe("2025-03-01"); // last_order_at = tanggal historis ASLI, bukan waktu commit
  });

  it("struktur modul tidak menyebut dispatch_plan/owner_alert/achievement", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = ["service.ts", "repository.ts", "validators.ts", "actions.ts"];
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      expect(content).not.toMatch(/dispatch_plan|owner_alert|createDispatch|sendOwnerAlert|achievement/i);
    }
  });
});

describe("17/18. Rollback aman dan diblokir jika direferensikan transaksi live", () => {
  it("rollback CUSTOMER_PIC yang belum disentuh siapa pun -> aman, data terhapus", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [
      ["TK-001", "Toko Satu", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"],
    ]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(repo.totalCustomers()).toBe(1);
    expect(repo.totalPics()).toBe(1);

    const rollback = await repo.rollbackBatch(COMPANY_A, staged.batchId, OWNER_A, "UAT: salah upload");
    expect(rollback.outcome).toBe("rolled_back");
    expect(repo.totalCustomers()).toBe(0);
    expect(repo.totalPics()).toBe(0);
  });

  it("rollback ditolak jika PIC sudah diverifikasi (live reference)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [
      ["TK-001", "Toko Satu", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"],
    ]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    const picId = rows[0]!.committedEntityId!;
    repo.getPicSync(picId)!.validationStatus = "VERIFIED_BY_ADMIN"; // simulasikan admin sudah verifikasi manual

    const rollback = await repo.rollbackBatch(COMPANY_A, staged.batchId, OWNER_A, "UAT: coba rollback");
    expect(rollback.outcome).toBe("blocked");
    expect(rollback.blockers?.length).toBeGreaterThan(0);
    expect(repo.totalPics()).toBe(1); // TIDAK terhapus
  });

  it("rollback dua kali (retry) idempotent -- kedua kalinya already_rolled_back", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);

    const first = await repo.rollbackBatch(COMPANY_A, staged.batchId, OWNER_A, "UAT");
    const second = await repo.rollbackBatch(COMPANY_A, staged.batchId, OWNER_A, "UAT lagi");
    expect(first.outcome).toBe("rolled_back");
    expect(second.outcome).toBe("already_rolled_back");
  });

  it("rollback wajib alasan", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    const result = await repo.rollbackBatch(COMPANY_A, staged.batchId, OWNER_A, "");
    expect(result.outcome).toBe("invalid_input");
  });
});

describe("19. Audit lengkap", () => {
  it("commit sukses menghasilkan commitResult dan committedAt tercatat pada batch", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "PRODUCT_PRICE", headers, [["PRD-001", "SBN-001", "Sabun", "dus", "40000", "TRUE"]]);
    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    const batch = await repo.getBatch(COMPANY_A, staged.batchId);
    expect(batch?.committedAt).not.toBeNull();
    expect((batch?.commitResult as { createdCount?: number })?.createdCount).toBe(1);
  });
});

describe("20. Raw file tidak masuk log (audit payload minimal)", () => {
  it("actions.ts tidak pernah memasukkan fileText/isi file mentah ke audit log", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const content = fs.readFileSync(path.join(dir, "actions.ts"), "utf8");
    // Audit event hanya boleh mencatat metadata (totalRows, importType, filename), bukan fileText/rows/content mentah.
    const auditCalls = content.match(/logAuditEvent\(\{[\s\S]*?\}\);/g) ?? [];
    for (const call of auditCalls) {
      expect(call).not.toMatch(/fileText|rawData|fileBytes/);
    }
  });
});

describe("21. Formula/path traversal tidak dieksekusi saat normalisasi", () => {
  it("cell formula pada nama toko dinetralisasi (tidak pernah dieksekusi), tetap tersimpan sebagai teks", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const headers = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
    const staged = await uploadAndValidate(repo, COMPANY_A, OWNER_A, "CUSTOMER_PIC", headers, [
      ["TK-001", "=SUM(A1:A10)", "", "", "", "", "PIC Satu", "081200002222", "", "OWNER", "TRUE"],
    ]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.normalizedData.store_name).toBe("'=SUM(A1:A10)");
  });
});
