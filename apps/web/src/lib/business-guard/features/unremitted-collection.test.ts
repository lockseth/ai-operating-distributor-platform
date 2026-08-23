import { describe, expect, it } from "vitest";
import {
  matchUnremittedClaims,
  detectUnremittedCollectionRisk,
  type ClaimedActivityInput,
  type PaymentClaimInput,
  type MatchedClaimedActivity,
} from "./unremitted-collection";

const NOW = new Date("2026-08-23T00:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function activity(overrides: Partial<ClaimedActivityInput>): ClaimedActivityInput {
  return {
    activity_id: "act-1",
    customer_id: "cust-1",
    customer_name: "Toko Uji",
    collector_id: "user-1",
    collector_name: "Budi",
    outcome: "claimed_paid_full",
    reported_amount: 1_000_000,
    occurred_at: daysAgo(0),
    ...overrides,
  };
}

function claim(overrides: Partial<PaymentClaimInput>): PaymentClaimInput {
  return {
    claim_id: "claim-1",
    customer_id: "cust-1",
    claimed_by: "user-1",
    claimed_at: daysAgo(0),
    ...overrides,
  };
}

describe("matchUnremittedClaims", () => {
  it("1 activity + 1 claim setelahnya -> matched", () => {
    const result = matchUnremittedClaims(
      [activity({ activity_id: "a1", occurred_at: daysAgo(10) })],
      [claim({ claim_id: "c1", claimed_at: daysAgo(5) })],
    );
    expect(result[0]!.matched).toBe(true);
    expect(result[0]!.matched_claim_id).toBe("c1");
  });

  it("1 activity tanpa claim sama sekali -> unmatched", () => {
    const result = matchUnremittedClaims([activity({ activity_id: "a1", occurred_at: daysAgo(10) })], []);
    expect(result[0]!.matched).toBe(false);
    expect(result[0]!.matched_claim_id).toBeNull();
  });

  it("claim ada tapi SEBELUM occurred_at -> tidak dihitung, tetap unmatched", () => {
    const result = matchUnremittedClaims(
      [activity({ activity_id: "a1", occurred_at: daysAgo(5) })],
      [claim({ claim_id: "c1", claimed_at: daysAgo(10) })], // 10 hari lalu, LEBIH AWAL dari activity 5 hari lalu
    );
    expect(result[0]!.matched).toBe(false);
  });

  it("KASUS REGRESI UTAMA: 2 activity (customer+collector sama), cuma 1 claim setelah keduanya -> activity TERTUA matched, yang lebih baru TETAP unmatched", () => {
    const older = activity({ activity_id: "a-older", occurred_at: daysAgo(20) });
    const newer = activity({ activity_id: "a-newer", occurred_at: daysAgo(10) });
    const oneClaim = claim({ claim_id: "c1", claimed_at: daysAgo(5) }); // setelah KEDUANYA

    const result = matchUnremittedClaims([older, newer], [oneClaim]);
    const olderResult = result.find((r) => r.activity_id === "a-older")!;
    const newerResult = result.find((r) => r.activity_id === "a-newer")!;

    // Ini test yang GAGAL kalau pakai EXISTS check naif (keduanya akan
    // matched=true karena satu claim yang sama "ditemukan" dua kali tanpa
    // pernah benar-benar dikonsumsi).
    expect(olderResult.matched).toBe(true);
    expect(olderResult.matched_claim_id).toBe("c1");
    expect(newerResult.matched).toBe(false);
    expect(newerResult.matched_claim_id).toBeNull();
  });

  it("grouping benar per collector -- customer sama, 2 collector beda, claim cuma untuk 1 collector", () => {
    const activityA = activity({ activity_id: "a-collectorA", collector_id: "user-A", occurred_at: daysAgo(10) });
    const activityB = activity({ activity_id: "a-collectorB", collector_id: "user-B", occurred_at: daysAgo(10) });
    const claimForA = claim({ claim_id: "c1", claimed_by: "user-A", claimed_at: daysAgo(5) });

    const result = matchUnremittedClaims([activityA, activityB], [claimForA]);
    expect(result.find((r) => r.activity_id === "a-collectorA")!.matched).toBe(true);
    expect(result.find((r) => r.activity_id === "a-collectorB")!.matched).toBe(false);
  });

  it("claim untuk customer lain tidak pernah nyambung", () => {
    const result = matchUnremittedClaims(
      [activity({ activity_id: "a1", customer_id: "cust-1", occurred_at: daysAgo(10) })],
      [claim({ claim_id: "c1", customer_id: "cust-OTHER", claimed_at: daysAgo(5) })],
    );
    expect(result[0]!.matched).toBe(false);
  });

  it("multiple claim eligible -> yang PALING AWAL yang dipakai, bukan yang paling dekat waktu", () => {
    const act = activity({ activity_id: "a1", occurred_at: daysAgo(20) });
    const earlyClaim = claim({ claim_id: "c-early", claimed_at: daysAgo(15) });
    const lateClaim = claim({ claim_id: "c-late", claimed_at: daysAgo(2) });

    const result = matchUnremittedClaims([act], [lateClaim, earlyClaim]); // urutan input sengaja dibalik
    expect(result[0]!.matched_claim_id).toBe("c-early");
  });

  it("2 activity + 2 claim yang urut waktu benar -> keduanya matched (tidak ada yang berebut)", () => {
    const a1 = activity({ activity_id: "a1", occurred_at: daysAgo(20) });
    const a2 = activity({ activity_id: "a2", occurred_at: daysAgo(10) });
    const c1 = claim({ claim_id: "c1", claimed_at: daysAgo(15) });
    const c2 = claim({ claim_id: "c2", claimed_at: daysAgo(5) });

    const result = matchUnremittedClaims([a1, a2], [c1, c2]);
    expect(result.find((r) => r.activity_id === "a1")!.matched_claim_id).toBe("c1");
    expect(result.find((r) => r.activity_id === "a2")!.matched_claim_id).toBe("c2");
  });

  it("urutan hasil mengikuti urutan input activities, bukan urutan proses internal (by occurred_at)", () => {
    const newer = activity({ activity_id: "a-newer", occurred_at: daysAgo(5) });
    const older = activity({ activity_id: "a-older", occurred_at: daysAgo(20) });
    const result = matchUnremittedClaims([newer, older], []); // input: newer dulu, older belakangan
    expect(result.map((r) => r.activity_id)).toEqual(["a-newer", "a-older"]);
  });
});

function matched(overrides: Partial<MatchedClaimedActivity>): MatchedClaimedActivity {
  return {
    ...activity({}),
    matched: false,
    matched_claim_id: null,
    ...overrides,
  };
}

describe("detectUnremittedCollectionRisk", () => {
  it("matched=true -> selalu NONE, terlepas dari occurred_at", () => {
    const result = detectUnremittedCollectionRisk(matched({ matched: true, occurred_at: daysAgo(30) }), NOW);
    expect(result.risk_level).toBe("NONE");
  });

  it("daysElapsed 0, 1, 2 (unmatched) -> NONE (masa tenggang)", () => {
    for (const d of [0, 1, 2]) {
      const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(d) }), NOW);
      expect(result.risk_level, `d=${d}`).toBe("NONE");
    }
  });

  it("daysElapsed 3 (batas bawah) -> MEDIUM", () => {
    const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(3) }), NOW);
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("daysElapsed 6 -> MEDIUM", () => {
    const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(6) }), NOW);
    expect(result.risk_level).toBe("MEDIUM");
  });

  it("daysElapsed 7 (batas bawah HIGH) -> HIGH", () => {
    const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(7) }), NOW);
    expect(result.risk_level).toBe("HIGH");
  });

  it("daysElapsed 30 -> HIGH, dengan confidence lebih tinggi dari kasus 7 hari (monotonic)", () => {
    const day7 = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(7) }), NOW);
    const day30 = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(30) }), NOW);
    expect(day30.risk_level).toBe("HIGH");
    expect(day30.confidence).toBeGreaterThan(day7.confidence);
  });

  it("reported_amount null -> tidak crash, recommendation tetap terbentuk", () => {
    const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(10), reported_amount: null }), NOW);
    expect(result.risk_level).toBe("HIGH");
    expect(result.recommendation).toContain("nominal tidak dicatat");
  });

  it("confidence selalu di rentang (0, 0.97]", () => {
    const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(60) }), NOW);
    expect(result.confidence).toBeLessThanOrEqual(0.97);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("risk_level LOW tidak pernah dipakai fungsi ini", () => {
    for (const d of [0, 1, 2, 3, 6, 7, 30, 90]) {
      const result = detectUnremittedCollectionRisk(matched({ occurred_at: daysAgo(d) }), NOW);
      expect(result.risk_level).not.toBe("LOW");
    }
  });
});
