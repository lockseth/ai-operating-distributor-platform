// Gate 3E-C-C2-B4-R1 — unit tests untuk pure decision logic confirm
// (lib/auth/confirm.ts). Tidak butuh DB/browser -- murni fungsi in-memory,
// selaras pola lib/auth/callback.test.ts.

import { describe, expect, it } from "vitest";
import { resolveConfirmNextPath } from "./confirm";

describe("resolveConfirmNextPath", () => {
  it("mengizinkan /reset-password", () => {
    expect(resolveConfirmNextPath("/reset-password")).toBe("/reset-password");
  });

  it("next null -> fallback /reset-password", () => {
    expect(resolveConfirmNextPath(null)).toBe("/reset-password");
  });

  it("next string kosong -> fallback /reset-password", () => {
    expect(resolveConfirmNextPath("")).toBe("/reset-password");
  });

  it("menolak URL absolut ke origin lain", () => {
    expect(resolveConfirmNextPath("https://evil.com/reset-password")).toBe("/reset-password");
    expect(
      resolveConfirmNextPath("https://aodp-waluyo-demo.vercel.app.evil.com/reset-password")
    ).toBe("/reset-password");
  });

  it("menolak protocol-relative URL", () => {
    expect(resolveConfirmNextPath("//evil.com/reset-password")).toBe("/reset-password");
    expect(resolveConfirmNextPath("//evil.com")).toBe("/reset-password");
  });

  it("menolak backslash bypass", () => {
    expect(resolveConfirmNextPath("/\\evil.com")).toBe("/reset-password");
    expect(resolveConfirmNextPath("\\\\evil.com")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/\\/evil.com")).toBe("/reset-password");
  });

  it("menolak path internal lain yang belum diaudit/di-allowlist", () => {
    expect(resolveConfirmNextPath("/dashboard")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/login")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/")).toBe("/reset-password");
  });

  it("hanya exact match yang diterima -- trailing slash/query/fragment tambahan ditolak", () => {
    expect(resolveConfirmNextPath("/reset-password/")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/reset-password?x=1")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/reset-password#x")).toBe("/reset-password");
    expect(resolveConfirmNextPath("/reset-passwordd")).toBe("/reset-password");
  });
});
