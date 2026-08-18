import { describe, it, expect } from "vitest";
import { aggregateTopProducts, aggregateTopCustomers, summarizeRiskLevels } from "./aggregates";

describe("aggregateTopProducts", () => {
  it("array kosong -> array kosong, tidak crash", () => {
    expect(aggregateTopProducts([])).toEqual([]);
  });

  it("menjumlah quantity & revenue per product_id, urut revenue desc", () => {
    const result = aggregateTopProducts([
      { product_id: "p1", product_name: "Saos Sambal", quantity: 10, revenue: 100_000 },
      { product_id: "p1", product_name: "Saos Sambal", quantity: 5, revenue: 50_000 },
      { product_id: "p2", product_name: "Kecap Manis", quantity: 20, revenue: 200_000 },
    ]);
    expect(result).toEqual([
      { product_name: "Kecap Manis", total_quantity: 20, total_revenue: 200_000 },
      { product_name: "Saos Sambal", total_quantity: 15, total_revenue: 150_000 },
    ]);
  });

  it("product_id null -> fallback grouping by product_name", () => {
    const result = aggregateTopProducts([
      { product_id: null, product_name: "Produk Legacy", quantity: 3, revenue: 30_000 },
      { product_id: null, product_name: "Produk Legacy", quantity: 2, revenue: 20_000 },
    ]);
    expect(result).toEqual([{ product_name: "Produk Legacy", total_quantity: 5, total_revenue: 50_000 }]);
  });

  it("limit membatasi jumlah hasil ke top-N", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      product_id: `p${i}`,
      product_name: `Produk ${i}`,
      quantity: 1,
      revenue: i * 1000,
    }));
    const result = aggregateTopProducts(rows, 5);
    expect(result).toHaveLength(5);
    expect(result[0]!.total_revenue).toBe(14_000); // tertinggi
  });
});

describe("aggregateTopCustomers", () => {
  it("array kosong -> array kosong, tidak crash", () => {
    expect(aggregateTopCustomers([])).toEqual([]);
  });

  it("menghitung order_count & total_revenue per customer, urut revenue desc", () => {
    const result = aggregateTopCustomers([
      { customer_id: "c1", customer_name: "Toko A", final_amount: 500_000 },
      { customer_id: "c1", customer_name: "Toko A", final_amount: 300_000 },
      { customer_id: "c2", customer_name: "Toko B", final_amount: 1_000_000 },
    ]);
    expect(result).toEqual([
      { customer_id: "c2", customer_name: "Toko B", order_count: 1, total_revenue: 1_000_000 },
      { customer_id: "c1", customer_name: "Toko A", order_count: 2, total_revenue: 800_000 },
    ]);
  });
});

describe("summarizeRiskLevels", () => {
  it("array kosong -> semua 0", () => {
    expect(summarizeRiskLevels([])).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("menghitung tiap tier, NONE tidak dihitung (bukan alert)", () => {
    const result = summarizeRiskLevels(["HIGH", "HIGH", "MEDIUM", "LOW", "NONE", "NONE"]);
    expect(result).toEqual({ high: 2, medium: 1, low: 1 });
  });
});
