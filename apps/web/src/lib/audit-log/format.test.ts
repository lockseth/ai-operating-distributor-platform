import { describe, expect, it } from "vitest";
import { formatJakartaDateTime, redactSensitive, summarizeChange } from "./format";

describe("formatJakartaDateTime", () => {
  it("mengonversi UTC ke Asia/Jakarta (UTC+7) dan menandai WIB", () => {
    // 2026-01-15T00:00:00Z == 2026-01-15T07:00:00+07:00
    const result = formatJakartaDateTime("2026-01-15T00:00:00Z");
    expect(result).toContain("07.00");
    expect(result).toContain("WIB");
  });

  it("mengembalikan em dash untuk input kosong/invalid", () => {
    expect(formatJakartaDateTime(null)).toBe("—");
    expect(formatJakartaDateTime(undefined)).toBe("—");
    expect(formatJakartaDateTime("not-a-date")).toBe("—");
  });
});

describe("redactSensitive", () => {
  it("mengganti nilai field bernama token/password/secret/session/credential dengan mask", () => {
    const input = {
      discount_limit: 8,
      api_key: "sk-live-abcdef",
      session_token: "xyz",
      pairing_secret: "123456",
      authorization: "Bearer abc",
      nested: { password: "hunter2", note: "aman" },
    };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result.discount_limit).toBe(8);
    expect(result.api_key).toBe("••••••");
    expect(result.session_token).toBe("••••••");
    expect(result.pairing_secret).toBe("••••••");
    expect(result.authorization).toBe("••••••");
    expect((result.nested as Record<string, unknown>).password).toBe("••••••");
    expect((result.nested as Record<string, unknown>).note).toBe("aman");
  });

  it("aman untuk null/array/primitif", () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
    expect(redactSensitive("plain string")).toBe("plain string");
    expect(redactSensitive([{ token: "abc" }])).toEqual([{ token: "••••••" }]);
  });
});

describe("summarizeChange", () => {
  it("menghasilkan baris ringkas per field yang berubah, bukan dump JSON mentah", () => {
    const lines = summarizeChange({ discount_limit: 5 }, { discount_limit: 8 });
    expect(lines).toEqual(["discount_limit: 5 → 8"]);
  });

  it("tidak menampilkan field yang nilainya tidak berubah", () => {
    const lines = summarizeChange({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(lines).toEqual(["b: 2 → 3"]);
  });

  it("field ditambahkan/dihapus ditandai eksplisit, bukan diam-diam hilang", () => {
    const lines = summarizeChange({ old_field: "x" }, { new_field: "y" });
    expect(lines).toContain("new_field: ditambahkan (y)");
    expect(lines).toContain("old_field: dihapus (sebelumnya x)");
  });

  it("mask field sensitif di before/after sebelum diringkas", () => {
    const lines = summarizeChange({ token: "old-secret" }, { token: "new-secret" });
    expect(lines).toEqual(["token: •••••• → ••••••"]);
  });

  it("mengembalikan array kosong bila before/after bukan objek (mis. null)", () => {
    expect(summarizeChange(null, null)).toEqual([]);
    expect(summarizeChange(undefined, undefined)).toEqual([]);
  });
});
