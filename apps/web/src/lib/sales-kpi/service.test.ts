// =============================================================================
// Blocker 3 -- pacing KPI harus memakai business date Asia/Jakarta, bukan
// UTC. todayIsoDate() (dipakai sebagai default `today` di
// computeAchievementLine, dipanggil implisit oleh
// SupabaseSalesKpiRepository/InMemorySalesKpiRepository.getAchievementProjection
// yang TIDAK PERNAH mengirim `today` eksplisit) sekarang delegasi penuh ke
// businessDateJakarta() (lib/n8n-automation/timezone.ts, helper authoritative
// yang sudah dipakai Morning Brief) -- tidak ada offset manual di sini.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { computeAchievementLine, todayIsoDate } from "./service";

describe("todayIsoDate -- business date Asia/Jakarta, bukan UTC", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lintas tengah malam UTC: UTC 20:00 (WIB 03:00 keesokan hari) -> mengikuti Jakarta, BUKAN kalender UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00Z"));

    expect(todayIsoDate()).toBe("2026-08-11");
    expect(todayIsoDate()).toBe(businessDateJakarta());
    expect(todayIsoDate()).not.toBe(new Date().toISOString().slice(0, 10)); // kalender UTC murni = 2026-08-10
  });

  it("UTC 16:59 (WIB 23:59, hari yang sama) -> belum lewat tengah malam Jakarta", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T16:59:00Z"));
    expect(todayIsoDate()).toBe("2026-08-10");
  });

  it("UTC 17:00 tepat (WIB 00:00, tengah malam Jakarta) -> sudah hari berikutnya", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T17:00:00Z"));
    expect(todayIsoDate()).toBe("2026-08-11");
  });
});

describe("computeAchievementLine -- default `today` (dipakai getAchievementProjection) memakai Jakarta", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("periode berakhir 2026-08-10, waktu sistem UTC 20:00 (Jakarta sudah 08-11) -> pacing COMPLETE, bukan ON_TRACK/AHEAD ala UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00Z"));

    const line = computeAchievementLine("CALL", 10, 5, { startDate: "2026-08-01", endDate: "2026-08-10" });
    expect(line.pacingStatus).toBe("COMPLETE");
  });

  it("target/actual/remaining/achievementPercentage TIDAK berubah -- hanya pacingStatus bergantung 'hari ini'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00Z"));

    const line = computeAchievementLine("CALL", 10, 5, { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(line.target).toBe(10);
    expect(line.actual).toBe(5);
    expect(line.remaining).toBe(5);
    expect(line.achievementPercentage).toBe(50);
  });

  it("today eksplisit tetap menang atas default (tidak ada regresi pada call site yang sudah passing today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T20:00:00Z")); // Jakarta 08-11, tapi diabaikan karena today eksplisit
    const line = computeAchievementLine(
      "CALL",
      10,
      5,
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      "2026-08-05",
    );
    expect(line.pacingStatus).not.toBe("COMPLETE");
  });
});
