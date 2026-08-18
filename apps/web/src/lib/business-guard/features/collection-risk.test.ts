import { describe, it, expect } from "vitest";
import { detectCollectionRisk, type CustomerCollectionActivity } from "./collection-risk";

const NOW = new Date("2026-08-18T00:00:00Z");

function invoice(daysOverdue: number, outstanding: number, invoiceNumber = "INV-1") {
  const due = new Date(NOW.getTime() - daysOverdue * 86_400_000);
  return { invoice_number: invoiceNumber, due_date: due.toISOString(), outstanding_balance: outstanding };
}

function activity(overrides: Partial<CustomerCollectionActivity> = {}): CustomerCollectionActivity {
  return {
    customer_id: "c1",
    customer_name: "Toko Sumber Rejeki",
    outstanding_invoices: [],
    broken_promise_count: 0,
    has_unresolved_dispute: false,
    ...overrides,
  };
}

describe("detectCollectionRisk", () => {
  it("tidak ada piutang outstanding -> NONE, tidak crash", () => {
    const result = detectCollectionRisk(activity(), NOW);
    expect(result.risk_level).toBe("NONE");
    expect(result.outstanding_invoice_count).toBe(0);
    expect(result.signals).toContain("Tidak ada piutang outstanding");
  });

  it("piutang masih dalam tempo (belum lewat jatuh tempo) -> NONE", () => {
    const result = detectCollectionRisk(
      activity({ outstanding_invoices: [invoice(-5, 500_000)] }), // belum jatuh tempo
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("lewat jatuh tempo 20 hari (dalam 0-30) -> masih NONE, di bawah ambang sinyal", () => {
    const result = detectCollectionRisk(activity({ outstanding_invoices: [invoice(20, 500_000)] }), NOW);
    expect(result.risk_level).toBe("NONE");
  });

  it("lewat jatuh tempo 45 hari (31-60) -> LOW/MEDIUM, ada sinyal aging", () => {
    const result = detectCollectionRisk(activity({ outstanding_invoices: [invoice(45, 500_000)] }), NOW);
    expect(result.risk_level).not.toBe("NONE");
    expect(result.signals.some((s) => s.includes("31-60 hari"))).toBe(true);
  });

  it("lewat jatuh tempo 75 hari (61-90) -> MEDIUM", () => {
    const result = detectCollectionRisk(activity({ outstanding_invoices: [invoice(75, 1_000_000)] }), NOW);
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("lewat jatuh tempo 120 hari (>90) -> HIGH", () => {
    const result = detectCollectionRisk(activity({ outstanding_invoices: [invoice(120, 2_000_000)] }), NOW);
    expect(result.risk_level).toBe("HIGH");
    expect(result.max_age_days).toBe(120);
  });

  it("beberapa invoice outstanding -> pakai umur TERTUA (worst-case), total_outstanding_amount dijumlah", () => {
    const result = detectCollectionRisk(
      activity({
        outstanding_invoices: [invoice(10, 300_000, "INV-1"), invoice(95, 700_000, "INV-2")],
      }),
      NOW,
    );
    expect(result.max_age_days).toBe(95);
    expect(result.total_outstanding_amount).toBe(1_000_000);
    expect(result.outstanding_invoice_count).toBe(2);
    expect(result.risk_level).toBe("HIGH");
  });

  it("janji bayar diingkari (broken promise) menambah skor walau umur piutang masih pendek", () => {
    const baseline = detectCollectionRisk(activity({ outstanding_invoices: [invoice(10, 500_000)] }), NOW);
    const withBroken = detectCollectionRisk(
      activity({ outstanding_invoices: [invoice(10, 500_000)], broken_promise_count: 2 }),
      NOW,
    );
    expect(baseline.risk_level).toBe("NONE");
    expect(withBroken.risk_level).not.toBe("NONE");
    expect(withBroken.signals.some((s) => s.includes("diingkari"))).toBe(true);
  });

  it("broken_promise_count di-cap -- tidak melebihi 30 poin walau janji diingkari berkali-kali", () => {
    const many = detectCollectionRisk(
      activity({ outstanding_invoices: [invoice(10, 500_000)], broken_promise_count: 10 }),
      NOW,
    );
    const two = detectCollectionRisk(
      activity({ outstanding_invoices: [invoice(10, 500_000)], broken_promise_count: 2 }),
      NOW,
    );
    // 2x broken promise sudah cap (2*15=30) -- 10x broken tidak boleh beda skor/level
    expect(many.risk_level).toBe(two.risk_level);
  });

  it("dispute belum terselesaikan menambah sinyal", () => {
    const result = detectCollectionRisk(
      activity({ outstanding_invoices: [invoice(40, 500_000)], has_unresolved_dispute: true }),
      NOW,
    );
    expect(result.signals.some((s) => s.includes("dispute"))).toBe(true);
  });

  it("invoice tanpa due_date -- umur piutang null, tetap tidak crash, sinyal eksplisit", () => {
    const result = detectCollectionRisk(
      activity({ outstanding_invoices: [{ invoice_number: "INV-X", due_date: null, outstanding_balance: 500_000 }] }),
      NOW,
    );
    expect(result.max_age_days).toBeNull();
    expect(result.signals.some((s) => s.includes("tidak bisa dihitung"))).toBe(true);
  });

  it("kombinasi sinyal maksimal (aging >90 + broken promise + dispute) tetap di-cap 100, level HIGH", () => {
    const result = detectCollectionRisk(
      activity({
        outstanding_invoices: [invoice(150, 5_000_000)],
        broken_promise_count: 5,
        has_unresolved_dispute: true,
      }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.confidence).toBeLessThanOrEqual(0.97);
  });

  it("recommendation berbeda per tier risiko", () => {
    const high = detectCollectionRisk(activity({ outstanding_invoices: [invoice(100, 1_000_000)] }), NOW);
    const none = detectCollectionRisk(activity(), NOW);
    expect(high.recommendation).toContain("PRIORITAS TINGGI");
    expect(none.recommendation).toBe("Tidak ada tindakan diperlukan.");
  });
});
