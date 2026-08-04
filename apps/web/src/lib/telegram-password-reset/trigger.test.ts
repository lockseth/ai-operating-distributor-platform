import { describe, expect, it } from "vitest";
import { detectPasswordResetTrigger } from "./trigger";

describe("detectPasswordResetTrigger (Gate 3E-D2-B)", () => {
  it("menerima ketiga frasa exact yang diizinkan", () => {
    expect(detectPasswordResetTrigger("lupa password")).toBe(true);
    expect(detectPasswordResetTrigger("ganti password")).toBe(true);
    expect(detectPasswordResetTrigger("reset password")).toBe(true);
  });

  it("case-insensitive dan toleran whitespace berlebih/leading-trailing", () => {
    expect(detectPasswordResetTrigger("LUPA PASSWORD")).toBe(true);
    expect(detectPasswordResetTrigger("  reset   password  ")).toBe(true);
    expect(detectPasswordResetTrigger("Ganti Password")).toBe(true);
  });

  it("EXACT-match, bukan substring/free-text search -- teks lain yang mengandung frasa ditolak", () => {
    expect(detectPasswordResetTrigger("reset password saya nanti aja, order dulu ya")).toBe(false);
    expect(detectPasswordResetTrigger("tolong reset password")).toBe(false);
    expect(detectPasswordResetTrigger("reset password dong")).toBe(false);
  });

  it("frasa mirip tapi tidak persis terdaftar ditolak", () => {
    expect(detectPasswordResetTrigger("lupa pass")).toBe(false);
    expect(detectPasswordResetTrigger("password reset")).toBe(false);
    expect(detectPasswordResetTrigger("forgot password")).toBe(false);
  });

  it("teks kosong/tidak relevan ditolak", () => {
    expect(detectPasswordResetTrigger("")).toBe(false);
    expect(detectPasswordResetTrigger("halo")).toBe(false);
  });
});
