import { describe, expect, it } from "vitest";
import { businessDateJakarta, jakartaHourMinute } from "./timezone";

describe("businessDateJakarta -- Asia/Jakarta (WIB, UTC+7 tetap)", () => {
  it("UTC 17:00 tanggal X = WIB 00:00 tanggal X+1 (lewat tengah malam)", () => {
    // 2026-08-10T17:00:00Z + 7 jam = 2026-08-11T00:00:00 WIB
    const date = new Date("2026-08-10T17:00:00Z");
    expect(businessDateJakarta(date)).toBe("2026-08-11");
  });

  it("UTC 16:59 tanggal X masih WIB tanggal X (belum lewat tengah malam)", () => {
    const date = new Date("2026-08-10T16:59:00Z");
    expect(businessDateJakarta(date)).toBe("2026-08-10");
  });

  it("UTC 00:00 = WIB 07:00 hari yang sama", () => {
    const date = new Date("2026-08-10T00:00:00Z");
    expect(businessDateJakarta(date)).toBe("2026-08-10");
  });
});

describe("jakartaHourMinute", () => {
  it("UTC 00:00:00 -> WIB 07:00", () => {
    const date = new Date("2026-08-10T00:00:00Z");
    expect(jakartaHourMinute(date)).toEqual({ hour: 7, minute: 0 });
  });

  it("UTC 23:30:00 -> WIB 06:30 (hari berikutnya)", () => {
    const date = new Date("2026-08-10T23:30:00Z");
    expect(jakartaHourMinute(date)).toEqual({ hour: 6, minute: 30 });
  });

  it("tidak pernah mengembalikan offset manual +7 yang salah saat lintas komponen jam/menit", () => {
    // UTC 18:45 -> WIB 01:45 (bukan 25:45 -- pembuktian bahwa Intl benar-benar
    // menghitung ulang komponen jam, bukan menambahkan 7 mentah-mentah)
    const date = new Date("2026-08-10T18:45:00Z");
    expect(jakartaHourMinute(date)).toEqual({ hour: 1, minute: 45 });
  });
});
