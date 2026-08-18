import { describe, it, expect } from "vitest";
import { detectBehaviorChange, type CustomerBehaviorActivity } from "./behavior-change";

const NOW = new Date("2026-08-18T00:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function activity(overrides: Partial<CustomerBehaviorActivity> = {}): CustomerBehaviorActivity {
  return {
    customer_id: "c1",
    customer_name: "Toko Sumber Rejeki",
    confirmed_order_dates: [],
    pic_field_change_count: 0,
    pic_fully_replaced: false,
    has_duplicate_flag: false,
    ...overrides,
  };
}

/** Bikin histori order rutin tiap `intervalDays`, `count` order, order terakhir `daysSinceLast` hari lalu. */
function regularOrders(count: number, intervalDays: number, daysSinceLast: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(daysAgo(daysSinceLast + (count - 1 - i) * intervalDays));
  }
  return dates;
}

describe("detectBehaviorChange", () => {
  it("tidak ada histori order & tidak ada aktivitas PIC -> NONE, tidak crash", () => {
    const result = detectBehaviorChange(activity(), NOW);
    expect(result.risk_level).toBe("NONE");
    expect(result.days_since_last_order).toBeNull();
    expect(result.avg_order_interval_days).toBeNull();
    expect(result.signals).toContain("Belum ada perubahan perilaku mencurigakan terdeteksi");
  });

  it("histori order < 3 -> baseline tidak dihitung, sinyal eksplisit, tetap NONE", () => {
    const result = detectBehaviorChange(
      activity({ confirmed_order_dates: [daysAgo(10), daysAgo(40)] }),
      NOW,
    );
    expect(result.avg_order_interval_days).toBeNull();
    expect(result.risk_level).toBe("NONE");
    expect(result.signals.some((s) => s.includes("minimal 3 order"))).toBe(true);
  });

  it("pola order rutin, order terakhir masih dalam rentang wajar -> NONE", () => {
    const result = detectBehaviorChange(
      activity({ confirmed_order_dates: regularOrders(4, 14, 10) }), // interval 14 hari, order terakhir 10 hari lalu
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
    expect(result.avg_order_interval_days).toBe(14);
  });

  it("diam >1.5x rata-rata interval -> LOW", () => {
    const result = detectBehaviorChange(
      activity({ confirmed_order_dates: regularOrders(4, 10, 16) }), // ratio 1.6
      NOW,
    );
    expect(result.risk_level).toBe("LOW");
    expect(result.signals.some((s) => s.includes("mulai melebihi"))).toBe(true);
  });

  it("diam >2x rata-rata interval -> MEDIUM", () => {
    const result = detectBehaviorChange(
      activity({ confirmed_order_dates: regularOrders(4, 10, 25) }), // ratio 2.5
      NOW,
    );
    expect(result.risk_level).toBe("MEDIUM");
    expect(result.signals.some((s) => s.includes("2x rata-rata"))).toBe(true);
  });

  it("diam >3x rata-rata interval -> HIGH", () => {
    const result = detectBehaviorChange(
      activity({ confirmed_order_dates: regularOrders(4, 10, 35) }), // ratio 3.5
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.signals.some((s) => s.includes("jauh melebihi"))).toBe(true);
  });

  it("PIC diganti total -> LOW/MEDIUM walau pola order normal", () => {
    const baseline = detectBehaviorChange(activity({ confirmed_order_dates: regularOrders(4, 14, 10) }), NOW);
    const replaced = detectBehaviorChange(
      activity({ confirmed_order_dates: regularOrders(4, 14, 10), pic_fully_replaced: true }),
      NOW,
    );
    expect(baseline.risk_level).toBe("NONE");
    expect(replaced.risk_level).not.toBe("NONE");
    expect(replaced.signals.some((s) => s.includes("diganti total"))).toBe(true);
  });

  it("info PIC berubah 1x saja -> belum cukup naikkan level (di bawah ambang LOW)", () => {
    const result = detectBehaviorChange(activity({ pic_field_change_count: 1 }), NOW);
    expect(result.risk_level).toBe("NONE");
    expect(result.signals.some((s) => s.includes("berubah baru-baru ini"))).toBe(true);
  });

  it("info PIC berubah >=2x -> LOW", () => {
    const result = detectBehaviorChange(activity({ pic_field_change_count: 2 }), NOW);
    expect(result.risk_level).toBe("LOW");
    expect(result.signals.some((s) => s.includes("pola tidak biasa"))).toBe(true);
  });

  it("percobaan duplikasi PIC/toko sendirian -> belum cukup naikkan level", () => {
    const result = detectBehaviorChange(activity({ has_duplicate_flag: true }), NOW);
    expect(result.risk_level).toBe("NONE");
    expect(result.signals.some((s) => s.includes("duplikasi"))).toBe(true);
  });

  it("kombinasi order drop drastis + PIC diganti total -> HIGH, di-cap 100", () => {
    const result = detectBehaviorChange(
      activity({
        confirmed_order_dates: regularOrders(4, 10, 35), // ratio 3.5 -> +60
        pic_fully_replaced: true, // +30
        has_duplicate_flag: true, // +10
      }),
      NOW,
    );
    expect(result.risk_level).toBe("HIGH");
    expect(result.confidence).toBeLessThanOrEqual(0.97);
  });

  it("recommendation berbeda per tier risiko", () => {
    const high = detectBehaviorChange(activity({ confirmed_order_dates: regularOrders(4, 10, 35) }), NOW);
    const none = detectBehaviorChange(activity(), NOW);
    expect(high.recommendation).toContain("PRIORITAS TINGGI");
    expect(none.recommendation).toBe("Tidak ada tindakan diperlukan.");
  });
});
