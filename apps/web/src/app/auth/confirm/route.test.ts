// Gate 3E-C-C2-B4-R1 — behavioral tests untuk GET /auth/confirm. Mock
// @/lib/supabase/server sama seperti pola app/auth/callback/route.test.ts,
// supaya bisa diuji tanpa DB/browser sungguhan.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ getAll: () => [], set: vi.fn() })),
}));

const verifyOtp = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { verifyOtp },
  })),
}));

const ORIGIN = "https://aodp-waluyo-demo.vercel.app";

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("token_hash valid + type=recovery + next=/reset-password -> verifyOtp dipanggil, redirect same-origin ke /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(
        `${ORIGIN}/auth/confirm?token_hash=abc123&type=recovery&next=%2Freset-password`
      )
    );

    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "abc123",
      type: "recovery",
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
  });

  it("token_hash hilang -> gagal aman ke /login, verifyOtp TIDAK dipanggil (fail closed)", async () => {
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/confirm?type=recovery`));

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=recovery_failed`);
  });

  it("type bukan recovery (mis. signup) -> ditolak fail-closed, verifyOtp TIDAK dipanggil", async () => {
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc123&type=signup`)
    );

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=recovery_failed`);
  });

  it("type hilang sama sekali -> ditolak fail-closed", async () => {
    const { GET } = await import("./route");

    const res = await GET(new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc123`));

    expect(verifyOtp).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?error=recovery_failed`);
  });

  it("token_hash invalid/expired/reused -> gagal aman ke /login, pesan error Supabase TIDAK bocor ke redirect", async () => {
    verifyOtp.mockResolvedValue({
      error: { message: "Token has expired or is invalid" },
    });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=expired&type=recovery`)
    );

    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/login?error=recovery_failed`);
    expect(location).not.toContain("expired");
    expect(location).not.toContain("invalid");
  });

  it("verifyOtp melempar exception -> tetap gagal aman, tidak bocor ke response", async () => {
    verifyOtp.mockRejectedValue(new Error("network boom: internal detail"));
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc&type=recovery`)
    );

    const location = res.headers.get("location") ?? "";
    expect(location).toBe(`${ORIGIN}/login?error=recovery_failed`);
    expect(location).not.toContain("internal detail");
  });

  it("next eksternal (https://evil.com) ditolak, fallback ke /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(
        `${ORIGIN}/auth/confirm?token_hash=abc&type=recovery&next=https%3A%2F%2Fevil.com`
      )
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
  });

  it("next protocol-relative (//evil.com) ditolak, fallback ke /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc&type=recovery&next=%2F%2Fevil.com`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
  });

  it("next backslash bypass (/\\\\evil.com) ditolak, fallback ke /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc&type=recovery&next=%2F%5Cevil.com`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
  });

  it("tanpa parameter next sama sekali -> default ke /reset-password", async () => {
    verifyOtp.mockResolvedValue({ error: null });
    const { GET } = await import("./route");

    const res = await GET(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc&type=recovery`)
    );

    expect(res.headers.get("location")).toBe(`${ORIGIN}/reset-password`);
  });
});
