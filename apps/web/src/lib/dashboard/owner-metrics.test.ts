import { describe, expect, it } from "vitest";
import { sixMonthWindowStart } from "./owner-metrics";

// =============================================================================
// Gate Owner BI-A -- rolling 6-month window untuk chart Tren Revenue & Order
// / Performa Area. Sebelumnya hardcoded `new Date("2026-01-01")`: window
// tidak pernah bergeser seiring waktu berjalan, hanya melebar. Test ini
// membuktikan window sekarang deterministik terhadap `now` yang diberikan,
// bukan bergantung pada tanggal kalender tetap manapun -- termasuk
// 2026-01-01 itu sendiri.
// =============================================================================

describe("sixMonthWindowStart -- Gate Owner BI-A", () => {
  it("mengembalikan tanggal 1 pada bulan berjalan dikurangi 5 bulan (6 bulan kalender inklusif)", () => {
    expect(sixMonthWindowStart(new Date(2026, 7, 15))).toEqual(new Date(2026, 2, 1)); // Agu 2026 -> Mar 2026
  });

  it("tidak lagi bergantung pada 2026-01-01 -- benar untuk tanggal sebelum maupun sesudahnya", () => {
    expect(sixMonthWindowStart(new Date(2025, 5, 10))).toEqual(new Date(2025, 0, 1)); // Jun 2025 -> Jan 2025
    expect(sixMonthWindowStart(new Date(2027, 3, 1))).toEqual(new Date(2026, 10, 1)); // Apr 2027 -> Nov 2026
  });

  it("menangani rollover tahun dengan benar (Januari -> Agustus tahun sebelumnya)", () => {
    expect(sixMonthWindowStart(new Date(2026, 0, 20))).toEqual(new Date(2025, 7, 1)); // Jan 2026 -> Agu 2025
  });

  it("hasil bergeser seiring `now` bergeser -- window benar-benar rolling, bukan statis", () => {
    const august = sixMonthWindowStart(new Date(2026, 7, 1));
    const september = sixMonthWindowStart(new Date(2026, 8, 1));
    expect(september.getTime()).toBeGreaterThan(august.getTime());
    expect(september).toEqual(new Date(2026, 3, 1)); // Sep 2026 -> Apr 2026
  });
});
