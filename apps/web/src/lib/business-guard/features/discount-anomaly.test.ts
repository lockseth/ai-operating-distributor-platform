import { describe, it, expect } from "vitest";
import { detectDiscountAnomaly, type SalesDiscountRequest } from "./discount-anomaly";

const NOW = new Date("2026-08-14T00:00:00Z");
const PEER_BASELINE = { avg_requests_per_sales: 2, avg_discount_percentage: 10 };

function req(
  daysAgo: number,
  status: SalesDiscountRequest["status"],
  discount: number
): SalesDiscountRequest {
  const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
  return { status, requested_at: d.toISOString(), max_discount_percentage: discount };
}

describe("detectDiscountAnomaly", () => {
  it("tidak ada pengajuan sama sekali -> NONE, tidak crash", () => {
    const result = detectDiscountAnomaly(
      { sales_id: "s1", sales_name: "Budi", requests: [] },
      PEER_BASELINE,
      NOW
    );
    expect(result.risk_level).toBe("NONE");
    expect(result.total_requests).toBe(0);
    expect(result.signals).toContain("Tidak ada pengajuan harga khusus");
  });

  it("cuma 1 pengajuan -- di bawah ambang minimum -- tidak dinilai walau ditolak", () => {
    const result = detectDiscountAnomaly(
      { sales_id: "s1", sales_name: "Budi", requests: [req(5, "REJECTED", 50)] },
      PEER_BASELINE,
      NOW
    );
    expect(result.risk_level).toBe("NONE");
    expect(result.signals.some((s) => s.includes("terlalu sedikit"))).toBe(true);
  });

  it("pola wajar (sesuai rata-rata peer, tidak ada penolakan) -> NONE", () => {
    const result = detectDiscountAnomaly(
      {
        sales_id: "s1",
        sales_name: "Budi",
        requests: [req(60, "APPROVED", 10), req(20, "APPROVED", 10)],
      },
      PEER_BASELINE,
      NOW
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("tingkat penolakan tinggi (>=50%) -> naik risiko signifikan", () => {
    const result = detectDiscountAnomaly(
      {
        sales_id: "s1",
        sales_name: "Budi",
        requests: [
          req(90, "REJECTED", 10),
          req(80, "REJECTED", 10),
          req(70, "APPROVED", 10),
        ],
      },
      PEER_BASELINE,
      NOW
    );
    expect(result.rejection_rate).toBeCloseTo(2 / 3, 2);
    expect(["MEDIUM", "HIGH"]).toContain(result.risk_level);
    expect(result.signals.some((s) => s.includes("ditolak Owner"))).toBe(true);
  });

  it("volume jauh di atas rata-rata peer -> berkontribusi ke skor", () => {
    const manyRequests = Array.from({ length: 8 }, (_, i) => req(90 - i * 5, "APPROVED", 10));
    const result = detectDiscountAnomaly(
      { sales_id: "s1", sales_name: "Budi", requests: manyRequests },
      PEER_BASELINE, // avg_requests_per_sales = 2, jadi 8 request = 4x rata-rata
      NOW
    );
    expect(result.signals.some((s) => s.includes("rata-rata sales lain"))).toBe(true);
  });

  it("diskon jauh lebih dalam dari rata-rata peer -> berkontribusi ke skor", () => {
    const result = detectDiscountAnomaly(
      {
        sales_id: "s1",
        sales_name: "Budi",
        requests: [req(90, "APPROVED", 40), req(80, "APPROVED", 45)],
      },
      PEER_BASELINE, // avg_discount_percentage = 10, jadi ~42.5% = >4x rata-rata
      NOW
    );
    expect(result.avg_discount_percentage).toBeGreaterThan(40);
    expect(result.signals.some((s) => s.toLowerCase().includes("diskon"))).toBe(true);
  });

  it("eskalasi -- pengajuan melonjak 30 hari terakhir dibanding sebelumnya", () => {
    const result = detectDiscountAnomaly(
      {
        sales_id: "s1",
        sales_name: "Budi",
        requests: [
          req(50, "APPROVED", 10),
          req(25, "APPROVED", 10),
          req(20, "APPROVED", 10),
          req(10, "APPROVED", 10),
          req(5, "APPROVED", 10),
        ],
      },
      PEER_BASELINE,
      NOW
    );
    expect(result.recent_vs_prior_ratio).toBeGreaterThan(1);
  });

  it("worst case gabungan (volume tinggi + penolakan tinggi + diskon dalam) -> HIGH", () => {
    const requests: SalesDiscountRequest[] = [];
    for (let i = 0; i < 6; i++) requests.push(req(90 - i * 10, "REJECTED", 60));
    for (let i = 0; i < 3; i++) requests.push(req(10 - i * 2, "APPROVED", 55));
    const result = detectDiscountAnomaly(
      { sales_id: "s1", sales_name: "Budi", requests },
      PEER_BASELINE,
      NOW
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("skor selalu 0-100 dan confidence selalu 0-0.97 (tidak pernah overflow)", () => {
    const requests: SalesDiscountRequest[] = Array.from({ length: 20 }, (_, i) =>
      req(90 - i, "REJECTED", 90)
    );
    const result = detectDiscountAnomaly(
      { sales_id: "s1", sales_name: "Budi", requests },
      { avg_requests_per_sales: 0.1, avg_discount_percentage: 1 },
      NOW
    );
    expect(result.confidence).toBeLessThanOrEqual(0.97);
    expect(result.confidence).toBeGreaterThan(0);
  });
});
