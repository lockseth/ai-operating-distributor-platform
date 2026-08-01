// Gate 3D-B3-F1 — behavioral tests untuk GET /auth/callback. Mock
// @/lib/supabase/server sama seperti pola lib/auth/get-user.security.test.ts,
// supaya bisa diuji tanpa DB/browser sungguhan.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn() })),
}));

const exchangeCodeForSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession },
  })),
}));

const ORIGIN = "https://aodp-waluyo-demo.vercel.app";

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("code valid + next=/signup -> exchangeCodeForSession dipanggil, redirect same-origin ke /signup", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/callback?code=abc123&next=%2Fsignup`)
    );

    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/signup`);
  });

  it("code hilang -> gagal aman ke /login, exchange TIDAK dipanggil (fail closed)", async () => {
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/callback`));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=confirmation_failed`);
  });

  it("code invalid/expired -> gagal aman ke /login, pesan error Supabase TIDAK bocor ke redirect", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "Email link is invalid or has expired" },
    });
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/callback?code=expired`));

    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/login?error=confirmation_failed`);
    expect(location).not.toContain("invalid");
    expect(location).not.toContain("expired");
  });

  it("exchangeCodeForSession melempar exception -> tetap gagal aman, tidak bocor ke response", async () => {
    exchangeCodeForSession.mockRejectedValue(new Error("network boom: internal detail"));
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/callback?code=abc`));

    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/login?error=confirmation_failed`);
    expect(location).not.toContain("internal detail");
  });

  it("next eksternal (https://evil.com) ditolak, fallback ke /signup", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/callback?code=abc&next=https%3A%2F%2Fevil.com`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/signup`);
  });

  it("next protocol-relative (//evil.com) ditolak, fallback ke /signup", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/callback?code=abc&next=%2F%2Fevil.com`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/signup`);
  });

  it("next backslash bypass (/\\\\evil.com) ditolak, fallback ke /signup", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/callback?code=abc&next=%2F%5Cevil.com`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/signup`);
  });

  it("tanpa parameter next sama sekali -> default ke /signup", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/callback?code=abc`));

    expect(res.headers.get("location")).toBe(`${ORIGIN}/signup`);
  });
});
