// =============================================================================
// print-pagination.ts test -- membuktikan continuation panel: tidak ada item
// hilang/duplikat, urutan dipertahankan, identitas sama di seluruh panel,
// totals/signatures HANYA di panel final, ceiling count benar, edge case
// (1 item, exact boundary) benar.
// =============================================================================

import { describe, expect, it } from "vitest";
import { paginatePrintDocument } from "./print-pagination";
import type { PrintDocumentViewModel } from "./print-view-model";

const TENANT = {
  companyId: "company-swa",
  companyName: "PT SUMBER WARNA ALAM SUDIADA",
  companyAddress: "Jl. Cendana Raya Talun Cirebon 45171",
  companyEmail: "sumberwanaalamsudiada@gmail.com",
  companyPhone: "085185905859",
  logoUrl: null,
};

function vmWithLines(lineCount: number): PrintDocumentViewModel {
  return {
    documentTypeLabel: "PURCHASE ORDER",
    documentNumber: "SWAS-PO-20260812-000025",
    documentDateLabel: "12 Agustus 2026",
    dueDateLabel: "26 Agustus 2026 (14 Hari)",
    tenant: TENANT,
    storeCode: "CUST-25",
    storeName: "Toko Dua Puluh Lima",
    storeAddress: "Jl. Contoh No. 25, Cirebon",
    storePhone: "081200000025",
    salesmanName: "Budi Santoso",
    orderReference: "SO-25ITEMS-000001",
    deliveryReference: null,
    paymentTermsLabel: "14 Hari",
    lines: Array.from({ length: lineCount }, (_, i) => ({
      no: i + 1,
      productCode: `SKU-${String(i + 1).padStart(3, "0")}`,
      productName: `Produk Contoh ${i + 1}`,
      productType: "Sembako",
      unit: "dus",
      quantity: 5,
      unitPriceLabel: "Rp85.000",
      discountLabel: "Rp5.000",
      lineTotalLabel: "Rp420.000",
    })),
    subtotalLabel: `Rp${(lineCount * 425000).toLocaleString("id-ID")}`,
    totalDiscountLabel: `Rp${(lineCount * 5000).toLocaleString("id-ID")}`,
    grandTotalLabel: `Rp${(lineCount * 420000).toLocaleString("id-ID")}`,
    terbilangLabel: "Sekian Rupiah",
    signatures: { salesmanName: "Budi Santoso", delivererName: "Budi Santoso" },
    receiverName: "Pak Slamet",
  };
}

const CAPACITY = 10;

describe("paginatePrintDocument -- A. jumlah panel (ceiling) dan slicing", () => {
  it("1 item -> 1 panel", () => {
    const panels = paginatePrintDocument(vmWithLines(1), CAPACITY);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.lines).toHaveLength(1);
    expect(panels[0]!.isFirstPanel).toBe(true);
    expect(panels[0]!.isFinalPanel).toBe(true);
  });

  it("10 item (tepat batas) -> 1 panel", () => {
    const panels = paginatePrintDocument(vmWithLines(10), CAPACITY);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.lines).toHaveLength(10);
  });

  it("11 item -> 2 panel: 10 + 1", () => {
    const panels = paginatePrintDocument(vmWithLines(11), CAPACITY);
    expect(panels).toHaveLength(2);
    expect(panels[0]!.lines).toHaveLength(10);
    expect(panels[1]!.lines).toHaveLength(1);
  });

  it("20 item -> 2 panel: 10 + 10", () => {
    const panels = paginatePrintDocument(vmWithLines(20), CAPACITY);
    expect(panels).toHaveLength(2);
    expect(panels[0]!.lines).toHaveLength(10);
    expect(panels[1]!.lines).toHaveLength(10);
  });

  it("21 item -> 3 panel: 10 + 10 + 1", () => {
    const panels = paginatePrintDocument(vmWithLines(21), CAPACITY);
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => p.lines.length)).toEqual([10, 10, 1]);
  });

  it("25 item -> 3 panel: 10 + 10 + 5", () => {
    const panels = paginatePrintDocument(vmWithLines(25), CAPACITY);
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => p.lines.length)).toEqual([10, 10, 5]);
  });

  it("30 item -> 3 panel: 10 + 10 + 10", () => {
    const panels = paginatePrintDocument(vmWithLines(30), CAPACITY);
    expect(panels).toHaveLength(3);
    expect(panels.map((p) => p.lines.length)).toEqual([10, 10, 10]);
  });

  it("tidak ada item hilang atau duplikat -- gabungan seluruh panel === lines asli, urutan dipertahankan", () => {
    const vm = vmWithLines(25);
    const panels = paginatePrintDocument(vm, CAPACITY);
    const combined = panels.flatMap((p) => p.lines);
    expect(combined).toHaveLength(25);
    expect(combined.map((l) => l.no)).toEqual(vm.lines.map((l) => l.no));
    expect(combined.map((l) => l.productCode)).toEqual(vm.lines.map((l) => l.productCode));
    // Tidak ada duplikat productCode.
    expect(new Set(combined.map((l) => l.productCode)).size).toBe(25);
  });

  it("nomor urut item berlanjut (line.no TIDAK reset ke 1 pada panel kedua/ketiga)", () => {
    const panels = paginatePrintDocument(vmWithLines(25), CAPACITY);
    expect(panels[0]!.lines.map((l) => l.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(panels[1]!.lines.map((l) => l.no)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(panels[2]!.lines.map((l) => l.no)).toEqual([21, 22, 23, 24, 25]);
  });
});

describe("paginatePrintDocument -- B. identity", () => {
  it("semua panel memakai nomor dokumen, versi, dan pelanggan yang SAMA", () => {
    const panels = paginatePrintDocument(vmWithLines(25), CAPACITY, 3);
    for (const p of panels) {
      expect(p.documentNumber).toBe("SWAS-PO-20260812-000025");
      expect(p.documentVersion).toBe(3);
      expect(p.storeName).toBe("Toko Dua Puluh Lima");
      expect(p.storeCode).toBe("CUST-25");
      expect(p.tenant.companyId).toBe("company-swa");
    }
  });

  it("label Halaman X/N benar untuk setiap panel", () => {
    const panels = paginatePrintDocument(vmWithLines(25), CAPACITY);
    expect(panels.map((p) => `${p.pageIndex}/${p.pageCount}`)).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("documentVersion null bila tidak diberikan (default, tidak mengarang nilai)", () => {
    const panels = paginatePrintDocument(vmWithLines(11), CAPACITY);
    expect(panels[0]!.documentVersion).toBeNull();
    expect(panels[1]!.documentVersion).toBeNull();
  });
});

describe("paginatePrintDocument -- C. totals and signatures HANYA di panel final", () => {
  it("panel non-final TIDAK memiliki totals dan signatures (null, bukan nilai karangan)", () => {
    const panels = paginatePrintDocument(vmWithLines(25), CAPACITY);
    expect(panels[0]!.isFinalPanel).toBe(false);
    expect(panels[0]!.totals).toBeNull();
    expect(panels[0]!.signatures).toBeNull();
    expect(panels[0]!.receiverName).toBeNull();
    expect(panels[1]!.isFinalPanel).toBe(false);
    expect(panels[1]!.totals).toBeNull();
    expect(panels[1]!.signatures).toBeNull();
  });

  it("panel final memiliki totals (grand total dari SELURUH dokumen, bukan subtotal panel) dan signatures lengkap", () => {
    const vm = vmWithLines(25);
    const panels = paginatePrintDocument(vm, CAPACITY);
    const final = panels[2]!;
    expect(final.isFinalPanel).toBe(true);
    expect(final.totals).not.toBeNull();
    expect(final.totals!.grandTotalLabel).toBe(vm.grandTotalLabel);
    expect(final.totals!.subtotalLabel).toBe(vm.subtotalLabel);
    expect(final.signatures).toEqual(vm.signatures);
    expect(final.receiverName).toBe(vm.receiverName);
  });

  it("dokumen 1 panel (tidak continuation) -- panel satu-satunya adalah first DAN final, punya totals/signatures", () => {
    const panels = paginatePrintDocument(vmWithLines(7), CAPACITY);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.isFirstPanel).toBe(true);
    expect(panels[0]!.isFinalPanel).toBe(true);
    expect(panels[0]!.totals).not.toBeNull();
    expect(panels[0]!.signatures).not.toBeNull();
  });
});

describe("paginatePrintDocument -- exact boundary & edge cases", () => {
  it("kapasitas custom (bukan default) dihormati -- 5 item, capacity 2 -> 3 panel: 2+2+1", () => {
    const panels = paginatePrintDocument(vmWithLines(5), 2);
    expect(panels.map((p) => p.lines.length)).toEqual([2, 2, 1]);
  });

  it("pagination TIDAK mengubah data lines asli (pure function, tidak ada mutasi)", () => {
    const vm = vmWithLines(11);
    const linesBefore = JSON.stringify(vm.lines);
    paginatePrintDocument(vm, CAPACITY);
    expect(JSON.stringify(vm.lines)).toBe(linesBefore);
  });
});
