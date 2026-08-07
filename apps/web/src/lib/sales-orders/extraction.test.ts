// =============================================================================
// Test — Sales Order Extraction (parser murni, tanpa Supabase/Telegram).
// Fokus: Gate Parser Telegram P0 -- urutan kata bebas, harga opsional,
// ambiguitas toko/produk tidak boleh ditebak, satuan tidak ditebak.
// =============================================================================

import { describe, it, expect } from "vitest";
import { extractSalesOrder, isLikelyOrderMessage } from "./extraction";
import type { KnowledgeContext } from "./types";

function knowledge(overrides: Partial<KnowledgeContext> = {}): KnowledgeContext {
  return {
    companyId: "company-1",
    productAliases: [],
    customerAliases: [],
    unitAliases: [],
    discountPolicies: [],
    products: [],
    customers: [],
    knowledgeVersion: "v0-empty",
    ...overrides,
  };
}

describe("extractSalesOrder — bahasa lapangan urutan bebas", () => {
  it("toko + item menyatu satu kalimat ('Toko Maju minta cat avian putih 5 kaleng') -> item terekstrak, toko dikenali", () => {
    const result = extractSalesOrder("Toko Maju minta cat avian putih 5 kaleng", knowledge());
    expect(isLikelyOrderMessage(result)).toBe(true);
    expect(result.customer.name).toBe("Toko Maju");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productName).toBe("cat avian putih");
    expect(result.items[0]!.quantity).toBe(5);
    expect(result.items[0]!.unit).toBe("kaleng");
    // Harga tidak disebutkan -- opsional, TIDAK diberi default diam-diam.
    expect(result.items[0]!.unitPrice).toBeNull();
    expect(result.missingFields).toContain("items[0].unitPrice");
  });

  it("'Kirim ke sumber jaya besok, nippon merah 3 dus' -> toko dari 'kirim ke', item terekstrak, catatan pengiriman tersimpan", () => {
    const result = extractSalesOrder("Kirim ke sumber jaya besok, nippon merah 3 dus", knowledge());
    expect(isLikelyOrderMessage(result)).toBe(true);
    expect(result.customer.name).toBe("sumber jaya");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productName).toBe("nippon merah");
    expect(result.items[0]!.quantity).toBe(3);
    expect(result.items[0]!.unit).toBe("dus");
    expect(result.deliveryNote).toBe("besok");
  });

  it("item line tanpa kata 'harga' tetap terekstrak sebagai item (format baris terpisah)", () => {
    const result = extractSalesOrder("Order Toko Amanah:\nSapu Lidi 4 lusin", knowledge());
    expect(result.customer.name).toBe("Toko Amanah");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productName).toBe("Sapu Lidi");
    expect(result.items[0]!.quantity).toBe(4);
    expect(result.items[0]!.unit).toBe("lusin");
    expect(result.items[0]!.unitPrice).toBeNull();
  });

  it("baris murni nama toko (format existing, format existing tidak boleh regresi) tetap dikenali sebagai customer line, bukan item", () => {
    const result = extractSalesOrder(
      "Order Toko Sinar Jaya:\nCat Mawar Putih 20 dus harga 450 ribu",
      knowledge(),
    );
    expect(result.customer.name).toBe("Toko Sinar Jaya");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productName).toBe("Cat Mawar Putih");
  });

  it("kalimat tanpa penanda apapun yang bisa dipastikan (angka dalam kata, bukan digit) -> tidak dipaksakan jadi item", () => {
    const result = extractSalesOrder("Bu Ani tambah yang kemarin dua karton", knowledge());
    // "dua" adalah kata bilangan, bukan digit -- parser tidak menebak angka kata.
    expect(isLikelyOrderMessage(result)).toBe(false);
  });
});

describe("extractSalesOrder — resolusi alias unik", () => {
  it("alias produk unik ter-resolve ke nama & kode kanonik", () => {
    const kn = knowledge({
      productAliases: [
        { aliasText: "mw putih", productId: "prod-1", productName: "Cat Mawar Putih", productCode: "SKU-001", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = extractSalesOrder("Order Toko X:\nMW Putih 5 dus harga 100000", kn);
    expect(result.items[0]!.productName).toBe("Cat Mawar Putih");
    expect(result.items[0]!.productCode).toBe("SKU-001");
    expect(result.missingFields).not.toContain("items[0].productName.ambiguous");
  });

  it("alias toko unik ter-resolve ke kode customer", () => {
    const kn = knowledge({
      customerAliases: [
        { aliasText: "sj", customerId: "cust-1", customerName: "Toko Sinar Jaya", customerCode: "CUST-001", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = extractSalesOrder("Order SJ:\nBarang A 2 dus harga 10000", kn);
    expect(result.customer.code).toBe("CUST-001");
    expect(result.missingFields).not.toContain("customer.ambiguous");
  });
});

describe("extractSalesOrder — ambiguitas toko/produk TIDAK BOLEH ditebak", () => {
  it("dua alias berbeda (beda spasi) menunjuk PRODUK BERBEDA -> productName tetap teks mentah, ditandai ambiguous, TIDAK memilih kandidat pertama", () => {
    const kn = knowledge({
      productAliases: [
        { aliasText: "mw putih", productId: "prod-1", productName: "Cat Mawar Putih A", productCode: "SKU-001", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "mw  putih", productId: "prod-2", productName: "Cat Mawar Putih B", productCode: "SKU-002", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = extractSalesOrder("Order Toko X:\nMW Putih 5 dus harga 100000", kn);
    // Teks mentah dipertahankan -- BUKAN "Cat Mawar Putih A" (kandidat pertama).
    expect(result.items[0]!.productName).toBe("MW Putih");
    expect(result.items[0]!.productCode).toBeNull();
    expect(result.missingFields).toContain("items[0].productName.ambiguous");
  });

  it("dua alias berbeda (beda huruf besar-kecil) menunjuk CUSTOMER BERBEDA -> customer.code null, ditandai ambiguous, TIDAK memilih kandidat pertama", () => {
    const kn = knowledge({
      customerAliases: [
        { aliasText: "toko maju", customerId: "cust-1", customerName: "Toko Maju Selatan", customerCode: "CUST-A", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "TOKO MAJU", customerId: "cust-2", customerName: "Toko Maju Utara", customerCode: "CUST-B", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = extractSalesOrder("Order Toko Maju:\nBarang A 2 dus harga 10000", kn);
    expect(result.customer.name).toBe("Toko Maju");
    expect(result.customer.code).toBeNull();
    expect(result.missingFields).toContain("customer.ambiguous");
  });

  it("produk tidak ditemukan sama sekali -> NOT_FOUND, teks mentah dipertahankan, TIDAK membuat master baru (code tetap null)", () => {
    const result = extractSalesOrder("Order Toko X:\nProduk Antah Berantah 2 dus harga 10000", knowledge());
    expect(result.items[0]!.productName).toBe("Produk Antah Berantah");
    expect(result.items[0]!.productCode).toBeNull();
    expect(result.missingFields).not.toContain("items[0].productName.ambiguous");
  });
});

describe("extractSalesOrder — quantity/unit tidak jelas TIDAK diberi default diam-diam", () => {
  it("quantity benar-benar tidak ada (bukan '0', tapi tidak disebutkan sama sekali) -> quantity null, ditandai missing, bukan 0", () => {
    const result = extractSalesOrder("Order Toko Y:\nCat Tembok harga 50000", knowledge());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.quantity).toBeNull();
    expect(result.items[0]!.unit).toBeNull();
    expect(result.missingFields).toContain("items[0].quantity");
    expect(result.missingFields).toContain("items[0].unit");
  });
});

describe("extractSalesOrder — pesan asli tidak pernah diubah oleh parser", () => {
  it("rawText input tidak dimutasi/diubah oleh proses ekstraksi", () => {
    const original = "Order Toko Z 🎉:\nBarang Typo Ringann 3 dus harga 25rb";
    const snapshot = original;
    extractSalesOrder(original, knowledge());
    expect(original).toBe(snapshot);
  });
});
