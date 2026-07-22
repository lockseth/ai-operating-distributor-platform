import { describe, expect, it } from "vitest";
import { computeLineTotal, computeTotals, formatRupiah, terbilang } from "./monetary";
import type { DocumentLineSnapshot } from "./types";

describe("computeLineTotal", () => {
  it("quantity * unitPrice - discountAmount", () => {
    expect(computeLineTotal({ quantity: 10, unitPrice: 5000, discountAmount: 2000 })).toBe(48000);
  });

  it("diskon nol -> line total = quantity * unitPrice", () => {
    expect(computeLineTotal({ quantity: 3, unitPrice: 1000, discountAmount: 0 })).toBe(3000);
  });
});

function line(overrides: Partial<DocumentLineSnapshot> = {}): DocumentLineSnapshot {
  return {
    no: 1,
    productCode: "SKU-1",
    productName: "Produk",
    productType: null,
    unit: "dus",
    quantity: 1,
    unitPrice: 1000,
    discountAmount: 0,
    lineTotal: 1000,
    ...overrides,
  };
}

describe("computeTotals", () => {
  it("subtotal, totalDiscount, grandTotal terhitung benar dari beberapa baris", () => {
    const lines = [
      line({ quantity: 10, unitPrice: 5000, discountAmount: 2000 }),
      line({ quantity: 2, unitPrice: 3000, discountAmount: 0 }),
    ];
    const totals = computeTotals(lines);
    expect(totals.subtotal).toBe(10 * 5000 + 2 * 3000);
    expect(totals.totalDiscount).toBe(2000);
    expect(totals.grandTotal).toBe(totals.subtotal - totals.totalDiscount);
  });

  it("tidak ada baris -> semua nol", () => {
    const totals = computeTotals([]);
    expect(totals).toEqual({ subtotal: 0, totalDiscount: 0, grandTotal: 0 });
  });
});

describe("formatRupiah -- presentasi string murni", () => {
  it("memformat dengan pemisah ribuan ala Indonesia", () => {
    expect(formatRupiah(1234567)).toBe("Rp1.234.567");
  });

  it("membulatkan tanpa mengubah nilai domain (hanya string)", () => {
    expect(formatRupiah(999.6)).toBe("Rp1.000");
  });
});

describe("terbilang -- LOCKED: satu-satunya baris tambahan Totals selain Subtotal/Potongan/Total (tanpa DPP/PPN)", () => {
  it("nol", () => {
    expect(terbilang(0)).toBe("Nol Rupiah");
  });

  it("1-11 langsung dari tabel satuan", () => {
    expect(terbilang(1)).toBe("Satu Rupiah");
    expect(terbilang(11)).toBe("Sebelas Rupiah");
  });

  it("12-19 pakai akhiran 'belas'", () => {
    expect(terbilang(12)).toBe("Dua Belas Rupiah");
    expect(terbilang(17)).toBe("Tujuh Belas Rupiah");
  });

  it("puluhan", () => {
    expect(terbilang(20)).toBe("Dua Puluh Rupiah");
    expect(terbilang(45)).toBe("Empat Puluh Lima Rupiah");
  });

  it("seratus (khusus, bukan 'satu ratus')", () => {
    expect(terbilang(100)).toBe("Seratus Rupiah");
    expect(terbilang(150)).toBe("Seratus Lima Puluh Rupiah");
  });

  it("ratusan", () => {
    expect(terbilang(250)).toBe("Dua Ratus Lima Puluh Rupiah");
  });

  it("seribu (khusus, bukan 'satu ribu')", () => {
    expect(terbilang(1000)).toBe("Seribu Rupiah");
    expect(terbilang(1500)).toBe("Seribu Lima Ratus Rupiah");
  });

  it("ribuan", () => {
    expect(terbilang(5000)).toBe("Lima Ribu Rupiah");
  });

  it("jutaan -- kasus nyata dari demo Gate6 (Rp2.620.000)", () => {
    expect(terbilang(2_620_000)).toBe("Dua Juta Enam Ratus Dua Puluh Ribu Rupiah");
  });

  it("miliar", () => {
    expect(terbilang(1_250_000_000)).toBe("Satu Miliar Dua Ratus Lima Puluh Juta Rupiah");
  });

  it("membulatkan desimal ke rupiah bulat (tidak menghasilkan pecahan dalam kata)", () => {
    expect(terbilang(1999.9)).toBe("Dua Ribu Rupiah");
  });

  it("nilai negatif -> awalan 'Minus' (bukan diam-diam dijadikan positif)", () => {
    expect(terbilang(-5000)).toBe("Minus Lima Ribu Rupiah");
  });

  it("tidak pernah mengandung kata DPP/PPN/pajak apa pun -- LOCKED business decision", () => {
    const result = terbilang(2_620_000).toUpperCase();
    expect(result).not.toContain("PPN");
    expect(result).not.toContain("DPP");
    expect(result).not.toContain("PAJAK");
  });
});
