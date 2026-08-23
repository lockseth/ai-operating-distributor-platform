import { describe, expect, it } from "vitest";
import { detectSuspiciousCallTiming, type SalesCallTimingInput, type SalesDayCallActivity } from "./call-timing-anomaly";

const NOW = new Date("2026-08-23T12:00:00Z");

function call(overrides: Partial<SalesCallTimingInput>): SalesCallTimingInput {
  return {
    call_id: "call-1",
    customer_id: "cust-1",
    customer_name: "Toko A",
    occurred_at: "2026-08-23T08:00:00Z",
    ...overrides,
  };
}

function activity(overrides: Partial<SalesDayCallActivity>): SalesDayCallActivity {
  return {
    salesperson_id: "sales-1",
    salesperson_name: "Budi",
    call_date: "2026-08-23",
    calls: [],
    ...overrides,
  };
}

function at(hhmmss: string): string {
  return `2026-08-23T${hhmmss}Z`;
}

describe("detectSuspiciousCallTiming", () => {
  it("gap tunggal 45 detik (customer beda) -- di bawah ambang severe, skor 40 -> MEDIUM (bukan HIGH sendirian, butuh Sinyal B untuk HIGH)", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", customer_id: "cust-1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", customer_id: "cust-2", occurred_at: at("08:00:45") }),
        ],
      }),
      NOW,
    );
    expect(result.min_gap_seconds).toBe(45);
    expect(result.severe_gap_count).toBe(1);
    expect(result.tight_gap_count).toBe(1);
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("batas: gap TEPAT 60 detik -- BUKAN severe, masuk tier <120 saja -> skor 22 -> LOW", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:01:00") }),
        ],
      }),
      NOW,
    );
    expect(result.min_gap_seconds).toBe(60);
    expect(result.severe_gap_count).toBe(0);
    expect(result.tight_gap_count).toBe(1);
    expect(result.risk_level).toBe("LOW");
  });

  it("batas: gap TEPAT 120 detik -- bukan tight sama sekali -> skor 0 -> NONE", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:02:00") }),
        ],
      }),
      NOW,
    );
    expect(result.tight_gap_count).toBe(0);
    expect(result.risk_level).toBe("NONE");
  });

  it("gap 121 detik -> NONE", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:02:01") }),
        ],
      }),
      NOW,
    );
    expect(result.risk_level).toBe("NONE");
  });

  it("TEST REGRESI KRITIS: 2 call ke customer YANG SAMA (kunjungan ulang terotorisasi) dengan gap rapat -- tidak boleh crash/mengasumsikan customer beda", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", customer_id: "cust-1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", customer_id: "cust-1", occurred_at: at("08:00:30") }),
        ],
      }),
      NOW,
    );
    expect(result.min_gap_seconds).toBe(30);
    expect(result.flagged_pairs[0]!.customer_a).toBe("cust-1");
    expect(result.flagged_pairs[0]!.customer_b).toBe("cust-1");
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("6 call/hari, 4 gap <120s, gap terketat 55s -> Sinyal A(40)+Sinyal B(30)=70 -> HIGH, tight_gap_count persis 4", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", customer_id: "cust-1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", customer_id: "cust-2", occurred_at: at("08:00:55") }), // gap 55s (severe+tight)
          call({ call_id: "c3", customer_id: "cust-3", occurred_at: at("08:01:50") }), // gap 55s (severe+tight)
          call({ call_id: "c4", customer_id: "cust-4", occurred_at: at("08:03:00") }), // gap 70s (tight)
          call({ call_id: "c5", customer_id: "cust-5", occurred_at: at("08:04:30") }), // gap 90s (tight)
          call({ call_id: "c6", customer_id: "cust-6", occurred_at: at("08:15:00") }), // gap 630s (jauh)
        ],
      }),
      NOW,
    );
    expect(result.min_gap_seconds).toBe(55);
    expect(result.tight_gap_count).toBe(4);
    expect(result.risk_level).toBe("HIGH");
  });

  it("kurang dari 2 call -> NONE, min_gap_seconds null, tidak crash", () => {
    const zeroCall = detectSuspiciousCallTiming(activity({ calls: [] }), NOW);
    expect(zeroCall.risk_level).toBe("NONE");
    expect(zeroCall.min_gap_seconds).toBeNull();

    const oneCall = detectSuspiciousCallTiming(activity({ calls: [call({})] }), NOW);
    expect(oneCall.risk_level).toBe("NONE");
    expect(oneCall.min_gap_seconds).toBeNull();
  });

  it("input array urutan terbalik -- fungsi mengurutkan sendiri by occurred_at sebelum hitung gap", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "later", occurred_at: at("08:01:00") }),
          call({ call_id: "earlier", occurred_at: at("08:00:00") }),
        ],
      }),
      NOW,
    );
    expect(result.min_gap_seconds).toBe(60);
  });

  it("flagged_pairs HANYA berisi pasangan gap <120s, bukan semua pasangan berurutan", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:00:50") }), // gap 50s -- tight
          call({ call_id: "c3", occurred_at: at("08:10:00") }), // gap 550s -- tidak tight
          call({ call_id: "c4", occurred_at: at("08:20:00") }), // gap 600s -- tidak tight
          call({ call_id: "c5", occurred_at: at("08:30:00") }), // gap 600s -- tidak tight
        ],
      }),
      NOW,
    );
    expect(result.flagged_pairs.length).toBe(1);
    expect(result.flagged_pairs[0]!.gap_seconds).toBe(50);
  });

  it("risk_level LOW tercapai dan berbeda dari NONE/MEDIUM (gap tunggal 90 detik)", () => {
    const result = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:01:30") }), // gap 90s
        ],
      }),
      NOW,
    );
    expect(result.risk_level).toBe("LOW");
  });

  it("confidence selalu di rentang (0, 0.97] di semua level risiko yang bisa dicapai (skor maksimum realistis 70, cap 100 murni defensif)", () => {
    const high = detectSuspiciousCallTiming(
      activity({
        calls: [
          call({ call_id: "c1", occurred_at: at("08:00:00") }),
          call({ call_id: "c2", occurred_at: at("08:00:55") }),
          call({ call_id: "c3", occurred_at: at("08:01:50") }),
          call({ call_id: "c4", occurred_at: at("08:03:00") }),
          call({ call_id: "c5", occurred_at: at("08:04:30") }),
        ],
      }),
      NOW,
    );
    expect(high.risk_level).toBe("HIGH");
    expect(high.confidence).toBeGreaterThan(0);
    expect(high.confidence).toBeLessThanOrEqual(0.97);

    const none = detectSuspiciousCallTiming(activity({ calls: [] }), NOW);
    expect(none.confidence).toBeGreaterThan(0);
    expect(none.confidence).toBeLessThanOrEqual(0.97);
  });
});
