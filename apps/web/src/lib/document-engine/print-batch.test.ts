// =============================================================================
// print-batch.ts test -- membuktikan pengelompokan panel (setelah pagination
// per transaksi) ke physical sheet Continuous Form 3 Ply (dua slot 5.5in
// per sheet 9.5x11in). LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE":
// transaksi panjang di-paginate menjadi beberapa panel SEBELUM masuk antrean
// sheet -- satu panel TIDAK PERNAH berisi bagian dari dua transaksi
// berbeda, tapi satu sheet BOLEH berisi dua transaksi pendek, dua halaman
// dari satu transaksi panjang, atau halaman final + halaman awal transaksi
// berikutnya.
// =============================================================================

import { describe, expect, it } from "vitest";
import { buildPrintSheets, CrossTenantBatchError } from "./print-batch";
import type { PrintDocumentViewModel } from "./print-view-model";

function vm(documentNumber: string, companyId = "company-swa", lineCount = 1, storeName = "Toko Sari"): PrintDocumentViewModel {
  return {
    documentTypeLabel: "INVOICE / FAKTUR",
    documentNumber,
    documentDateLabel: "11 Agustus 2026",
    dueDateLabel: null,
    tenant: {
      companyId,
      companyName: "PT SUMBER WARNA ALAM SUDIADA",
      companyAddress: "Jl. Cendana Raya Talun Cirebon 45171",
      companyEmail: "sumberwanaalamsudiada@gmail.com",
      companyPhone: "085185905859",
      logoUrl: null,
    },
    storeCode: "CUST-1",
    storeName,
    storeAddress: "Jl. Mangga 1",
    storePhone: "081200000001",
    salesmanName: "Budi",
    orderReference: "SO-0001",
    deliveryReference: "DO-0001",
    paymentTermsLabel: null,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      no: i + 1,
      productCode: `SKU-${i + 1}`,
      productName: "Indomie Goreng",
      productType: "Mie Instan",
      unit: "dus",
      quantity: 10,
      unitPriceLabel: "Rp 85.000",
      discountLabel: "Rp 5.000",
      lineTotalLabel: "Rp 845.000",
    })),
    subtotalLabel: "Rp 845.000",
    totalDiscountLabel: "Rp 5.000",
    grandTotalLabel: "Rp 840.000",
    terbilangLabel: "Delapan ratus empat puluh ribu rupiah",
    signatures: { salesmanName: "Budi", delivererName: "Budi" },
    receiverName: null,
  };
}

const CAPACITY = 10;

describe("buildPrintSheets -- dokumen pendek (tanpa continuation)", () => {
  it("array kosong -> daftar sheet kosong (bukan error, bukan dummy sheet)", () => {
    expect(buildPrintSheets([], CAPACITY)).toEqual([]);
  });

  it("4 transaksi pendek -> 2 physical sheet, masing-masing 2 slot penuh, urutan deterministik", () => {
    const sheets = buildPrintSheets([vm("A"), vm("B"), vm("C"), vm("D")], CAPACITY);
    expect(sheets).toHaveLength(2);
    expect(sheets[0]!.top.documentNumber).toBe("A");
    expect(sheets[0]!.bottom!.documentNumber).toBe("B");
    expect(sheets[1]!.top.documentNumber).toBe("C");
    expect(sheets[1]!.bottom!.documentNumber).toBe("D");
  });

  it("3 transaksi pendek (ganjil) -> 2 physical sheet, sheet terakhir slot bawah null (bukan dummy)", () => {
    const sheets = buildPrintSheets([vm("A"), vm("B"), vm("C")], CAPACITY);
    expect(sheets).toHaveLength(2);
    expect(sheets[1]!.top.documentNumber).toBe("C");
    expect(sheets[1]!.bottom).toBeNull();
  });

  it("batch berisi tenant (company_id) berbeda -- ditolak eksplisit, bukan dipasangkan diam-diam", () => {
    expect(() => buildPrintSheets([vm("A", "company-swa"), vm("B", "company-other")], CAPACITY)).toThrow(CrossTenantBatchError);
  });
});

describe("buildPrintSheets -- D. continuation (transaksi panjang, LOCK 'AODP WALUYO')", () => {
  it("25 item (3 continuation panel: 10+10+5) -> 2 physical sheet: sheet1=[1/3,2/3], sheet2=[3/3, kosong]", () => {
    const sheets = buildPrintSheets([vm("SWAS-PO-25ITEMS", "company-swa", 25)], CAPACITY);
    expect(sheets).toHaveLength(2);

    expect(sheets[0]!.top.documentNumber).toBe("SWAS-PO-25ITEMS");
    expect(sheets[0]!.top.pageIndex).toBe(1);
    expect(sheets[0]!.top.pageCount).toBe(3);
    expect(sheets[0]!.top.lines).toHaveLength(10);

    expect(sheets[0]!.bottom!.documentNumber).toBe("SWAS-PO-25ITEMS");
    expect(sheets[0]!.bottom!.pageIndex).toBe(2);
    expect(sheets[0]!.bottom!.pageCount).toBe(3);
    expect(sheets[0]!.bottom!.lines).toHaveLength(10);

    expect(sheets[1]!.top.documentNumber).toBe("SWAS-PO-25ITEMS");
    expect(sheets[1]!.top.pageIndex).toBe(3);
    expect(sheets[1]!.top.pageCount).toBe(3);
    expect(sheets[1]!.top.lines).toHaveLength(5);
    expect(sheets[1]!.top.isFinalPanel).toBe(true);

    // Panel bawah sheet terakhir kosong (tidak ada dokumen berikutnya dalam batch) -- bukan dummy.
    expect(sheets[1]!.bottom).toBeNull();
  });

  it("tidak ada item tertukar antarhalaman -- gabungan lines seluruh panel continuation === 25 item asli berurutan", () => {
    const source = vm("SWAS-PO-25ITEMS", "company-swa", 25);
    const sheets = buildPrintSheets([source], CAPACITY);
    const allPanels = [sheets[0]!.top, sheets[0]!.bottom!, sheets[1]!.top];
    const combined = allPanels.flatMap((p) => p.lines);
    expect(combined.map((l) => l.no)).toEqual(source.lines.map((l) => l.no));
    expect(combined.map((l) => l.productCode)).toEqual(source.lines.map((l) => l.productCode));
  });

  it("dokumen berikutnya dalam batch memakai slot SETELAH continuation secara deterministik (panel bawah sheet2 terisi, bukan kosong)", () => {
    const longDoc = vm("SWAS-PO-25ITEMS", "company-swa", 25, "Toko Panjang");
    const nextDoc = vm("SWAS-INV-NEXT", "company-swa", 1, "Toko Berikutnya");
    const sheets = buildPrintSheets([longDoc, nextDoc], CAPACITY);
    expect(sheets).toHaveLength(2);
    expect(sheets[1]!.top.documentNumber).toBe("SWAS-PO-25ITEMS");
    expect(sheets[1]!.top.pageIndex).toBe(3);
    // Slot bawah sheet kedua sekarang terisi dokumen berikutnya, BUKAN kosong.
    expect(sheets[1]!.bottom).not.toBeNull();
    expect(sheets[1]!.bottom!.documentNumber).toBe("SWAS-INV-NEXT");
    expect(sheets[1]!.bottom!.storeName).toBe("Toko Berikutnya");
    // Data pelanggan tidak bocor antar dokumen.
    expect(sheets[1]!.top.storeName).toBe("Toko Panjang");
  });

  it("continuation dari tenant berbeda TIDAK BOLEH bercampur dalam satu batch", () => {
    const longDocTenantA = vm("SWAS-PO-25ITEMS", "company-swa", 25);
    const shortDocTenantB = vm("OTHER-INV-1", "company-other", 1);
    expect(() => buildPrintSheets([longDocTenantA, shortDocTenantB], CAPACITY)).toThrow(CrossTenantBatchError);
  });

  it("jumlah panel dihitung deterministik SEBELUM render -- 2 dokumen panjang (25 item masing-masing) menghasilkan urutan panel yang stabil dan dapat diprediksi", () => {
    const docA = vm("DOC-A", "company-swa", 25);
    const docB = vm("DOC-B", "company-swa", 25);
    const sheets = buildPrintSheets([docA, docB], CAPACITY);
    // 3 panel (A) + 3 panel (B) = 6 panel -> 3 sheet.
    expect(sheets).toHaveLength(3);
    const order = sheets.flatMap((s) => [s.top, s.bottom]).filter(Boolean).map((p) => `${p!.documentNumber}#${p!.pageIndex}/${p!.pageCount}`);
    expect(order).toEqual([
      "DOC-A#1/3",
      "DOC-A#2/3",
      "DOC-A#3/3",
      "DOC-B#1/3",
      "DOC-B#2/3",
      "DOC-B#3/3",
    ]);
  });
});
