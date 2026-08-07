// =============================================================================
// Test — Pricing (resolusi id produk/customer + kalkulasi diskon).
// Fokus: ambiguitas via fallback NAMA KANONIK (bukan alias) -- customers.name
// dan products.name TIDAK unique per company (lihat migration
// 20260626000003_create_business_tables.sql, hanya code/sku yang unique),
// jadi dua toko/produk BERBEDA bisa punya nama identik. resolveCustomerId/
// resolveProductId tidak boleh memilih kandidat pertama dalam kasus ini.
// =============================================================================

import { describe, it, expect } from "vitest";
import { buildPricedOrder } from "./pricing";
import type { ExtractedSalesOrder } from "@flowsales/ai";
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

function extracted(overrides: Partial<ExtractedSalesOrder> = {}): ExtractedSalesOrder {
  return {
    customer: { name: null, code: null },
    items: [],
    deliveryNote: null,
    missingFields: [],
    confidence: 0.5,
    ...overrides,
  };
}

describe("buildPricedOrder — ambiguitas fallback nama kanonik", () => {
  it("dua CUSTOMER berbeda dengan NAMA SAMA PERSIS -> customerId null, customerAmbiguous true, TIDAK memilih kandidat pertama", () => {
    const kn = knowledge({
      customerAliases: [
        { aliasText: "toko maju-alias-1", customerId: "cust-1", customerName: "Toko Maju", customerCode: "C1", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "toko maju-alias-2", customerId: "cust-2", customerName: "Toko Maju", customerCode: "C2", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = buildPricedOrder(extracted({ customer: { name: "Toko Maju", code: null } }), kn);
    expect(result.customerId).toBeNull();
    expect(result.customerAmbiguous).toBe(true);
    // Nama mentah tetap ditampilkan ke sales (bukan disembunyikan).
    expect(result.customerName).toBe("Toko Maju");
  });

  it("dua PRODUK berbeda dengan NAMA SAMA PERSIS -> productId null, productAmbiguous true, TIDAK memilih kandidat pertama", () => {
    const kn = knowledge({
      productAliases: [
        { aliasText: "cat putih-alias-1", productId: "prod-1", productName: "Cat Putih", productCode: "P1", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "cat putih-alias-2", productId: "prod-2", productName: "Cat Putih", productCode: "P2", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = buildPricedOrder(
      extracted({
        items: [{ productName: "Cat Putih", productCode: null, quantity: 5, unit: "dus", unitPrice: 10000, discountType: null, discountValue: null, subtotal: null }],
      }),
      kn,
    );
    expect(result.items[0]!.productId).toBeNull();
    expect(result.items[0]!.productAmbiguous).toBe(true);
    expect(result.items[0]!.productName).toBe("Cat Putih");
  });

  it("satu customer dengan nama itu -> resolve normal (bukan false positive ambiguous)", () => {
    const kn = knowledge({
      customerAliases: [
        { aliasText: "toko tunggal-alias", customerId: "cust-1", customerName: "Toko Tunggal", customerCode: "C1", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = buildPricedOrder(extracted({ customer: { name: "Toko Tunggal", code: null } }), kn);
    expect(result.customerId).toBe("cust-1");
    expect(result.customerAmbiguous).toBe(false);
  });

  it("productCode unik dari extraction (alias sudah unik) -> lookup by-code tidak pernah ambigu meski ada baris alias lain untuk produk sama", () => {
    const kn = knowledge({
      productAliases: [
        { aliasText: "cat merah", productId: "prod-1", productName: "Cat Merah", productCode: "SKU-9", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "cm", productId: "prod-1", productName: "Cat Merah", productCode: "SKU-9", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    const result = buildPricedOrder(
      extracted({
        items: [{ productName: "Cat Merah", productCode: "SKU-9", quantity: 2, unit: "dus", unitPrice: 5000, discountType: null, discountValue: null, subtotal: null }],
      }),
      kn,
    );
    expect(result.items[0]!.productId).toBe("prod-1");
    expect(result.items[0]!.productAmbiguous).toBe(false);
  });
});
