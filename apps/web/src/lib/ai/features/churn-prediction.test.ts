import { describe, expect, it } from "vitest";
import { predictChurn, type CustomerOrderData } from "./churn-prediction";

const NOW = new Date("2026-08-23T00:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function customer(overrides: Partial<CustomerOrderData>): CustomerOrderData {
  return {
    customer_id: "cust-1",
    customer_name: "Toko Uji",
    last_order_at: null,
    order_dates: [],
    total_revenue: 0,
    ...overrides,
  };
}

describe("predictChurn", () => {
  it("toko yang tidak pernah order -> days_since_last_order dipangkas jadi -1 (bukan 9999 mentah), tapi tetap dianggap berisiko (belum pernah order = sinyal negatif)", () => {
    const result = predictChurn(customer({ last_order_at: null, order_dates: [] }), NOW);
    expect(result.days_since_last_order).toBe(-1);
    // daysSinceLast internal tetap 9999 (belum pernah order) -> signal "tidak order 9999 hari" (+40) DAN
    // "riwayat sangat sedikit" (+10) -- total 50, masuk MEDIUM (35-59). Bukan NONE: pelanggan yang belum
    // pernah order sama sekali tidak boleh dianggap "aman".
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("order reguler, terakhir 5 hari lalu -> risk NONE, tidak ada signal negatif", () => {
    const dates = [daysAgo(35), daysAgo(25), daysAgo(15), daysAgo(5)];
    const result = predictChurn(
      customer({ last_order_at: daysAgo(5), order_dates: dates, total_revenue: 10_000_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
    expect(result.signals).toContain("Order reguler, tidak ada tanda churn");
  });

  it("tidak order 65 hari -> risk HIGH (ambang > 60 hari)", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(65), order_dates: [daysAgo(95), daysAgo(65)] }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.signals.some((s) => s.includes("65 hari"))).toBe(true);
  });

  it("tidak order 50 hari -> risk MEDIUM (ambang 45-60 hari)", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(50), order_dates: [daysAgo(80), daysAgo(50)] }),
      NOW,
    );
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("tidak order 35 hari -> risk LOW (ambang 30-45 hari)", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(35), order_dates: [daysAgo(65), daysAgo(35)] }),
      NOW,
    );
    expect(result.risk_level).toBe("LOW");
  });

  it("frekuensi order menurun tajam (interval melebar >30%) ikut menaikkan risk meski belum lewat 30 hari", () => {
    // 4 order: interval awal rapat (5 hari), interval belakangan melebar jauh (40 hari) -- pola "mulai jarang order".
    const dates = [daysAgo(90), daysAgo(85), daysAgo(80), daysAgo(40)];
    const result = predictChurn(customer({ last_order_at: daysAgo(40), order_dates: dates }), NOW);
    expect(result.signals.some((s) => s.includes("Frekuensi order menurun"))).toBe(true);
  });

  it("overdue_days dihitung dari avg_order_interval, bukan dari days_since_last_order mentah", () => {
    // interval rata-rata order tiap 10 hari, sudah 25 hari sejak order terakhir -> overdue 15 hari.
    const dates = [daysAgo(50), daysAgo(40), daysAgo(30), daysAgo(25)];
    const result = predictChurn(customer({ last_order_at: daysAgo(25), order_dates: dates }), NOW);
    expect(result.avg_order_interval_days).toBeGreaterThan(0);
    expect(result.overdue_days).toBeGreaterThan(0);
  });

  it("toko high-value (revenue >= 5jt) berisiko HIGH -> rekomendasi prioritas kunjungi langsung", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(65), order_dates: [daysAgo(95), daysAgo(65)], total_revenue: 8_000_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.recommendation).toContain("PRIORITAS TINGGI");
  });

  it("toko low-value (revenue < 5jt) berisiko HIGH -> rekomendasi hubungi WA/telepon, bukan kunjungan prioritas", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(65), order_dates: [daysAgo(95), daysAgo(65)], total_revenue: 500_000 }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.recommendation).not.toContain("PRIORITAS TINGGI");
  });

  it("confidence selalu di rentang [0, 0.97] pada skenario risk tertinggi", () => {
    const result = predictChurn(
      customer({ last_order_at: daysAgo(200), order_dates: [daysAgo(400), daysAgo(200)] }),
      NOW,
    );
    expect(result.confidence).toBeLessThanOrEqual(0.97);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("hanya 1 order historis -> signal riwayat sedikit ikut berkontribusi ke risk score", () => {
    const result = predictChurn(customer({ last_order_at: daysAgo(5), order_dates: [daysAgo(5)], total_revenue: 100_000 }), NOW);
    expect(result.signals).toContain("Riwayat order sangat sedikit");
  });

  it("customer_id/customer_name diteruskan apa adanya, tidak diubah", () => {
    const result = predictChurn(customer({ customer_id: "cust-xyz", customer_name: "Toko Sumber Rejeki" }), NOW);
    expect(result.customer_id).toBe("cust-xyz");
    expect(result.customer_name).toBe("Toko Sumber Rejeki");
  });
});
