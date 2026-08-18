import { describe, it, expect } from "vitest";
import { detectTransactionRisk, type TransactionActivity } from "./transaction-risk";

const NOW = new Date("2026-08-19T00:00:00Z");

function activity(overrides: Partial<TransactionActivity> = {}): TransactionActivity {
  return {
    order_id: "o1",
    order_number: "SO-0001",
    customer_id: "c1",
    customer_name: "Toko Sumber Rejeki",
    confirmed_at: NOW.toISOString(),
    order_total_amount: 500_000,
    customer_avg_order_value: 500_000,
    is_first_order: false,
    company_avg_order_value: 500_000,
    item_quantity_outliers: [],
    ...overrides,
  };
}

describe("detectTransactionRisk", () => {
  it("order sesuai rata-rata customer sendiri -> NONE", () => {
    const result = detectTransactionRisk(activity(), NOW);
    expect(result.risk_level).toBe("NONE");
    expect(result.signals).toContain("Transaksi dalam pola wajar, tidak ada sinyal risiko");
  });

  it("order 2.5x rata-rata customer sendiri -> LOW", () => {
    const result = detectTransactionRisk(
      activity({ order_total_amount: 1_250_000, customer_avg_order_value: 500_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("LOW");
  });

  it("order 3.5x rata-rata customer sendiri -> MEDIUM", () => {
    const result = detectTransactionRisk(
      activity({ order_total_amount: 1_750_000, customer_avg_order_value: 500_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("order 6x rata-rata customer sendiri -> HIGH", () => {
    const result = detectTransactionRisk(
      activity({ order_total_amount: 3_000_000, customer_avg_order_value: 500_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.signals.some((s) => s.includes("6.0x"))).toBe(true);
  });

  it("customer belum punya histori (avg null) -> signal 1 di-skip, tidak crash", () => {
    const result = detectTransactionRisk(
      activity({ customer_avg_order_value: null, is_first_order: true, order_total_amount: 500_000, company_avg_order_value: 500_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("order pertama customer baru, 6x rata-rata company -> HIGH", () => {
    const result = detectTransactionRisk(
      activity({
        customer_avg_order_value: null,
        is_first_order: true,
        order_total_amount: 3_000_000,
        company_avg_order_value: 500_000,
      }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.signals.some((s) => s.includes("Order pertama"))).toBe(true);
  });

  it("order pertama customer baru, tapi nilai wajar (1x rata-rata company) -> NONE", () => {
    const result = detectTransactionRisk(
      activity({
        customer_avg_order_value: null,
        is_first_order: true,
        order_total_amount: 500_000,
        company_avg_order_value: 500_000,
      }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("bukan order pertama -> signal 2 tidak pernah dievaluasi walau nilainya besar", () => {
    const result = detectTransactionRisk(
      activity({
        is_first_order: false,
        customer_avg_order_value: 2_000_000, // sesuai baseline customer sendiri
        order_total_amount: 2_000_000,
        company_avg_order_value: 500_000, // company rata-rata jauh lebih kecil, tapi tidak relevan krn bukan first order
      }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("1 item quantity outlier sendirian -> belum cukup naikkan level (di bawah ambang LOW), tapi sinyal tercatat", () => {
    const result = detectTransactionRisk(
      activity({ item_quantity_outliers: [{ product_name: "Saos Sambal 500ml", quantity: 500, avg_quantity: 50 }] }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
    expect(result.signals.some((s) => s.includes("Saos Sambal 500ml"))).toBe(true);
  });

  it(">=2 item quantity outlier -> LOW", () => {
    const result = detectTransactionRisk(
      activity({
        item_quantity_outliers: [
          { product_name: "Saos Sambal 500ml", quantity: 500, avg_quantity: 50 },
          { product_name: "Kecap Manis 1L", quantity: 300, avg_quantity: 40 },
        ],
      }),
      NOW,
    );
    expect(result.risk_level).toBe("LOW");
  });

  it("kombinasi order besar + first order + quantity outlier -> HIGH, cap 100", () => {
    const result = detectTransactionRisk(
      activity({
        order_total_amount: 5_000_000,
        customer_avg_order_value: null,
        is_first_order: true,
        company_avg_order_value: 500_000,
        item_quantity_outliers: [
          { product_name: "Saos Sambal 500ml", quantity: 500, avg_quantity: 50 },
          { product_name: "Kecap Manis 1L", quantity: 300, avg_quantity: 40 },
        ],
      }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.confidence).toBeLessThanOrEqual(0.97);
  });

  it("recommendation berbeda per tier risiko", () => {
    const high = detectTransactionRisk(
      activity({ order_total_amount: 3_000_000, customer_avg_order_value: 500_000 }),
      NOW,
    );
    const none = detectTransactionRisk(activity(), NOW);
    expect(high.recommendation).toContain("PRIORITAS TINGGI");
    expect(none.recommendation).toBe("Tidak ada tindakan diperlukan.");
  });
});
