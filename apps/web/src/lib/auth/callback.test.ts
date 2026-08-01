// Gate 3D-B3-F1 — unit tests untuk pure decision logic callback
// (lib/auth/callback.ts). Tidak butuh DB/browser -- murni fungsi in-memory,
// selaras pola signup.test.ts.

import { describe, expect, it } from "vitest";
import { resolveCallbackNextPath } from "./callback";

describe("resolveCallbackNextPath", () => {
  it("mengizinkan /signup", () => {
    expect(resolveCallbackNextPath("/signup")).toBe("/signup");
  });

  it("next null -> fallback /signup", () => {
    expect(resolveCallbackNextPath(null)).toBe("/signup");
  });

  it("next string kosong -> fallback /signup", () => {
    expect(resolveCallbackNextPath("")).toBe("/signup");
  });

  it("menolak URL absolut ke origin lain", () => {
    expect(resolveCallbackNextPath("https://evil.com/signup")).toBe("/signup");
    expect(resolveCallbackNextPath("https://aodp-waluyo-demo.vercel.app.evil.com/signup")).toBe(
      "/signup"
    );
  });

  it("menolak protocol-relative URL", () => {
    expect(resolveCallbackNextPath("//evil.com/signup")).toBe("/signup");
    expect(resolveCallbackNextPath("//evil.com")).toBe("/signup");
  });

  it("menolak backslash bypass", () => {
    expect(resolveCallbackNextPath("/\\evil.com")).toBe("/signup");
    expect(resolveCallbackNextPath("\\\\evil.com")).toBe("/signup");
    expect(resolveCallbackNextPath("/\\/evil.com")).toBe("/signup");
  });

  it("menolak path internal lain yang belum diaudit/di-allowlist", () => {
    expect(resolveCallbackNextPath("/dashboard")).toBe("/signup");
    expect(resolveCallbackNextPath("/login")).toBe("/signup");
    expect(resolveCallbackNextPath("/")).toBe("/signup");
  });

  it("hanya exact match yang diterima -- trailing slash/query/fragment tambahan ditolak", () => {
    expect(resolveCallbackNextPath("/signup/")).toBe("/signup");
    expect(resolveCallbackNextPath("/signup?x=1")).toBe("/signup");
    expect(resolveCallbackNextPath("/signup#x")).toBe("/signup");
    expect(resolveCallbackNextPath("/signupp")).toBe("/signup");
  });
});
