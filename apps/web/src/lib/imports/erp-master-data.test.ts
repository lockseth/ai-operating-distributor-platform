// =============================================================================
// GATE AODP — ERP Master Data: PIC opsional, harga opsional, customers.city/
// province, edit UX. Scope RECONCILED (Founder): import tetap MANUAL lewat
// template AODP di Demo V2 -- TIDAK ada importer khusus yang otomatis
// mengonversi export ERP lama. Deferred (tidak diuji di sini): parser BIFF
// .xls, auto-normalisasi wilayah, partial batch commit, mapping alias
// khusus layout ERP Pak Waluyo, kategori produk & konversi kemasan.
// =============================================================================

import { describe, it, expect } from "vitest";
import { stageUploadedFile, validateStagedBatch } from "./service";
import { InMemoryImportRepository } from "./repository";
import { suggestColumnMapping } from "./mapping";
import { DOMAIN_FIELDS, type ColumnMapping, type ImportType } from "./types";

const COMPANY_A = "company-a";
const OWNER_A = "owner-a";

function makeRepo() {
  return new InMemoryImportRepository();
}

function seedBaseline(repo: InMemoryImportRepository) {
  repo.seedUser({ id: OWNER_A, companyId: COMPANY_A, fullName: "Owner A", role: "owner", isActive: true });
}

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

async function uploadAndValidate(
  repo: InMemoryImportRepository, importType: ImportType, headers: string[], rows: string[][], mapping?: ColumnMapping[]
) {
  const upload = await stageUploadedFile({ repository: repo }, {
    companyId: COMPANY_A, actorId: OWNER_A, importType, sourceSystem: "AODP Template",
    filename: "data.csv", fileBytes: encodeCsv(buildCsv(headers, rows)),
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.error}`);
  if (upload.needsSheetSelection) throw new Error("unexpected sheet selection");
  const validate = await validateStagedBatch({ repository: repo }, {
    companyId: COMPANY_A, batchId: upload.batchId, columnMappings: mapping ?? identityMapping(importType),
  });
  if (!validate.ok) throw new Error(`validate failed: ${validate.error}`);
  return { batchId: upload.batchId, summary: validate.summary };
}

const CUSTOMER_HEADERS = DOMAIN_FIELDS.CUSTOMER_PIC.map((f) => f.key);
// urutan: store_legacy_code, store_name, store_phone, store_address, store_area,
// assigned_salesman_name, pic_name, pic_phone, pic_email, pic_roles, is_active, store_city, store_province
function customerRow(overrides: Partial<{
  kode: string; nama: string; telepon: string; alamat: string; area: string; sales: string;
  picName: string; picPhone: string; picEmail: string; picRoles: string; aktif: string; kota: string; provinsi: string;
}> = {}): string[] {
  return [
    overrides.kode ?? "PL0001", overrides.nama ?? "TK WIJAYA FROZEN", overrides.telepon ?? "",
    overrides.alamat ?? "PASAR HARJAMUKTI", overrides.area ?? "", overrides.sales ?? "",
    overrides.picName ?? "", overrides.picPhone ?? "", overrides.picEmail ?? "", overrides.picRoles ?? "",
    overrides.aktif ?? "TRUE", overrides.kota ?? "CIREBON", overrides.provinsi ?? "JAWA BARAT",
  ];
}

const PRODUCT_HEADERS = DOMAIN_FIELDS.PRODUCT_PRICE.map((f) => f.key);
// urutan: product_legacy_code, sku, name, unit, price, is_active
function productRow(overrides: Partial<{
  kode: string; sku: string; nama: string; satuan: string; harga: string; aktif: string;
}> = {}): string[] {
  return [
    overrides.kode ?? "00001", overrides.sku ?? "00001", overrides.nama ?? "KECAP ANGGUR MANIS PET 135ML",
    overrides.satuan ?? "PCS", overrides.harga ?? "", overrides.aktif ?? "TRUE",
  ];
}

describe("Master pelanggan tanpa PIC (kontrak import poin 2)", () => {
  it("baris tanpa data PIC sama sekali -> toko dibuat, TIDAK ada customer_pics, TIDAK error", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "CUSTOMER_PIC", CUSTOMER_HEADERS, [customerRow()]);
    expect(staged.summary.errorRows).toBe(0);
    expect(staged.summary.readyToCommit).toBe(true);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.proposedAction).toBe("CREATE");
    expect(rows[0]?.normalizedData.pic_name).toBeNull();

    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(commit.outcome).toBe("committed");
    expect(repo.totalCustomers()).toBe(1);
    expect(repo.totalPics()).toBe(0); // tidak fabricate PIC dummy
  });

  it("sebagian field PIC terisi (nama ada, telepon kosong) -> NEEDS_REVIEW, tidak auto-commit", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "CUSTOMER_PIC", CUSTOMER_HEADERS, [
      customerRow({ picName: "Siti Aminah" }), // pic_phone & pic_roles kosong
    ]);
    expect(staged.summary.errorRows).toBe(1);
    expect(staged.summary.readyToCommit).toBe(false);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.proposedAction).toBe("NEEDS_REVIEW");
    expect(rows[0]?.errors.some((e) => e.field === "pic_phone")).toBe(true);
  });

  it("PIC lengkap & valid -> perilaku lama tetap jalan (toko + PIC dibuat)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "CUSTOMER_PIC", CUSTOMER_HEADERS, [
      customerRow({ picName: "Siti Aminah", picPhone: "081298765432", picRoles: "OWNER" }),
    ]);
    expect(staged.summary.errorRows).toBe(0);
    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(commit.outcome).toBe("committed");
    expect(repo.totalPics()).toBe(1);
  });
});

describe("Nama pelanggan sama, kode berbeda -> TIDAK digabung otomatis (kontrak import poin 8)", () => {
  it("dua toko dengan nama persis sama tapi kode legacy berbeda -> dua record customer terpisah", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "CUSTOMER_PIC", CUSTOMER_HEADERS, [
      customerRow({ kode: "PL0001", nama: "TK YAYAH" }),
      customerRow({ kode: "PL0099", nama: "TK YAYAH" }),
    ]);
    expect(staged.summary.errorRows).toBe(0);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows.every((r) => r.proposedAction === "CREATE")).toBe(true);

    await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(repo.totalCustomers()).toBe(2); // bukan 1 -- tidak digabung karena nama sama
  });
});

describe("customers.city/province ikut tersimpan lewat import manual", () => {
  it("store_city & store_province terisi -> tersimpan apa adanya di normalizedData (tanpa normalisasi otomatis)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "CUSTOMER_PIC", CUSTOMER_HEADERS, [
      customerRow({ kota: "Jakarta Selatan", provinsi: "DKI Jakarta" }),
    ]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.normalizedData.store_city).toBe("Jakarta Selatan");
    expect(rows[0]?.normalizedData.store_province).toBe("DKI Jakarta");
    expect(rows[0]?.warnings).toHaveLength(0); // tidak ada saran normalisasi otomatis (deferred)
  });

  it("mapping alias generik Kota/Provinsi tetap terpetakan (label template AODP)", () => {
    const mapping = suggestColumnMapping(["Kota", "Provinsi"], "CUSTOMER_PIC");
    const byCol = Object.fromEntries(mapping.map((m) => [m.sourceColumn, m.targetField]));
    expect(byCol["Kota"]).toBe("store_city");
    expect(byCol["Provinsi"]).toBe("store_province");
  });
});

describe("Produk tanpa harga (kontrak import poin 6)", () => {
  it("harga kosong -> produk tetap dibuat TAPI is_active dipaksa false (tidak bisa dipakai order)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "PRODUCT_PRICE", PRODUCT_HEADERS, [productRow({ harga: "" })]);
    expect(staged.summary.errorRows).toBe(0); // bukan error -- WARNING saja, tidak menolak seluruh baris
    expect(staged.summary.warningRows).toBe(1);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.normalizedData.is_active).toBe(false);
    expect(rows[0]?.normalizedData.price).toBe(0);

    const commit = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(commit.outcome).toBe("committed");
    const committedRows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    const product = repo.getProductSync(committedRows[0]!.committedEntityId!);
    expect(product?.isActive).toBe(false);
  });

  it("harga terisi > 0 -> produk aktif seperti biasa", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "PRODUCT_PRICE", PRODUCT_HEADERS, [productRow({ harga: "45000" })]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.normalizedData.is_active).toBe(true);
    expect(rows[0]?.normalizedData.price).toBe(45000);
    expect(rows[0]?.warnings.some((w) => w.field === "price")).toBe(false);
  });
});

describe("SKU/kode produk tidak kehilangan leading zero", () => {
  it("Kode Item '00001' tetap '00001' setelah normalisasi (bukan jadi angka 1)", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "PRODUCT_PRICE", PRODUCT_HEADERS, [
      productRow({ kode: "00001", sku: "00001" }),
    ]);
    const rows = await repo.getBatchRows(COMPANY_A, staged.batchId);
    expect(rows[0]?.normalizedData.sku).toBe("00001");
    expect(rows[0]?.normalizedData.product_legacy_code).toBe("00001");
  });
});

describe("Retry import ulang idempotent", () => {
  it("commit dua kali (retry) untuk batch PRODUCT_PRICE -> already_committed, tidak duplikat", async () => {
    const repo = makeRepo();
    seedBaseline(repo);
    const staged = await uploadAndValidate(repo, "PRODUCT_PRICE", PRODUCT_HEADERS, [productRow({ harga: "45000" })]);
    const first = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    const second = await repo.commitBatch(COMPANY_A, staged.batchId, OWNER_A);
    expect(first.outcome).toBe("committed");
    expect(second.outcome).toBe("already_committed");
    expect(repo.totalProducts()).toBe(1);
  });
});
