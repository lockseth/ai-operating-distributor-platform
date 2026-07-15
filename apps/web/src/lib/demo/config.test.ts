// =============================================================================
// Test — demo mode harus fail closed di production, termasuk saat NODE_ENV
// salah konfigurasi (typo, kosong, casing salah, dst). Satu-satunya nilai
// yang boleh mengaktifkan demo mode adalah string literal "development".
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import { isDemoModeAllowed } from "./config";

describe("isDemoModeAllowed — production fail-closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("true HANYA ketika NODE_ENV persis 'development'", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemoModeAllowed()).toBe(true);
  });

  it("false ketika NODE_ENV='production'", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemoModeAllowed()).toBe(false);
  });

  it("false ketika NODE_ENV='test' (lingkungan test itu sendiri)", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isDemoModeAllowed()).toBe(false);
  });

  it.each([
    "Development", // salah kapitalisasi
    "DEVELOPMENT",
    "dev",
    "develop",
    "production ", // spasi tersisa dari copy-paste .env
    " development",
    "productoin", // typo umum
    "",
    "1",
    "true",
    "undefined",
    "null",
  ])("false untuk NODE_ENV salah konfigurasi: %j (fail closed, bukan fail open)", (value) => {
    vi.stubEnv("NODE_ENV", value);
    expect(isDemoModeAllowed()).toBe(false);
  });

  it("false ketika NODE_ENV tidak di-set sama sekali (unset -> undefined, bukan 'development')", () => {
    vi.stubEnv("NODE_ENV", undefined);
    expect(isDemoModeAllowed()).toBe(false);
  });
});
