import { describe, expect, it } from "vitest";
import {
  dailySessionIdempotencyKey,
  isValidBusinessDate,
  validateReopenDailySessionInput,
  validateStartDailySessionInput,
} from "./service";

describe("isValidBusinessDate", () => {
  it("menerima tanggal ISO nyata", () => {
    expect(isValidBusinessDate("2026-07-18")).toBe(true);
  });

  it("menolak format bukan ISO atau tanggal palsu", () => {
    expect(isValidBusinessDate("18-07-2026")).toBe(false);
    expect(isValidBusinessDate("2026-02-30")).toBe(false);
    expect(isValidBusinessDate("")).toBe(false);
  });
});

describe("dailySessionIdempotencyKey", () => {
  it("deterministik per salesman + business date", () => {
    const key1 = dailySessionIdempotencyKey("sales-1", "2026-07-18");
    const key2 = dailySessionIdempotencyKey("sales-1", "2026-07-18");
    expect(key1).toBe(key2);
    expect(key1).toBe("daily_session:sales-1:2026-07-18");
  });

  it("berbeda antar salesman atau tanggal", () => {
    expect(dailySessionIdempotencyKey("sales-1", "2026-07-18")).not.toBe(
      dailySessionIdempotencyKey("sales-2", "2026-07-18"),
    );
    expect(dailySessionIdempotencyKey("sales-1", "2026-07-18")).not.toBe(
      dailySessionIdempotencyKey("sales-1", "2026-07-19"),
    );
  });
});

describe("validateStartDailySessionInput", () => {
  it("valid ketika tanggal ISO nyata dan idempotency key terisi", () => {
    expect(
      validateStartDailySessionInput({
        businessDate: "2026-07-18",
        idempotencyKey: "daily_session:sales-1:2026-07-18",
      }),
    ).toBeNull();
  });

  it("invalid_date untuk tanggal palsu", () => {
    expect(
      validateStartDailySessionInput({
        businessDate: "2026-13-01",
        idempotencyKey: "k",
      }),
    ).toBe("invalid_date");
  });

  it("idempotency_key_required untuk key kosong", () => {
    expect(
      validateStartDailySessionInput({
        businessDate: "2026-07-18",
        idempotencyKey: "   ",
      }),
    ).toBe("idempotency_key_required");
  });
});

describe("validateReopenDailySessionInput", () => {
  it("reason_required untuk alasan terlalu pendek", () => {
    expect(validateReopenDailySessionInput({ reason: "ok" })).toBe(
      "reason_required",
    );
  });

  it("valid untuk alasan >= 3 karakter", () => {
    expect(
      validateReopenDailySessionInput({ reason: "salah tutup hari" }),
    ).toBeNull();
  });
});
