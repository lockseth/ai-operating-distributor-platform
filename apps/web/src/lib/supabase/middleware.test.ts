// Gate 3E-C-C2-B4-R2-H1 — behavioral tests untuk updateSession() (dipanggil
// dari proxy.ts), fokus pada exact-match /api/health exemption dan bukti
// bahwa rute lain (termasuk yang mirip nama/lokasi) TIDAK ikut ter-exempt.
// Mock @supabase/ssr supaya bisa diuji tanpa network/DB sungguhan, identik
// pola app/auth/callback/route.test.ts (mock createClient di boundary-nya).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
  })),
}));

const ORIGIN = "https://aodp-waluyo-demo.vercel.app";

describe("updateSession -- /api/health exact-match exemption (Gate 3E-C-C2-B4-R2-H1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    getUser.mockResolvedValue({ data: { user: null } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("anonymous GET /api/health -- lolos tanpa redirect, getUser() TIDAK PERNAH dipanggil (bypass total, identik AUDITED_WEBHOOK_ROUTES)", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(new NextRequest(`${ORIGIN}/api/health`));

    expect(getUser).not.toHaveBeenCalled();
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it("authenticated GET /api/health -- tetap lolos (exemption tidak bergantung status auth sama sekali)", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const { updateSession } = await import("./middleware");
    const res = await updateSession(new NextRequest(`${ORIGIN}/api/health`));

    expect(getUser).not.toHaveBeenCalled();
    expect(res.status).not.toBe(307);
  });

  it("/api/health/private TIDAK ikut ter-exempt (bukan exact match) -- anonymous tetap di-redirect ke /login", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(new NextRequest(`${ORIGIN}/api/health/private`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("/api/health-check (nama mirip, bukan exact match) TIDAK ikut ter-exempt", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(new NextRequest(`${ORIGIN}/api/health-check`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("rute /api lain sembarang (tidak ada di allowlist manapun) tetap auth-gated -- bukan prefix /api", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(
      new NextRequest(`${ORIGIN}/api/internal/automation/dispatch-extra`)
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("halaman dashboard terproteksi -- anonymous tetap di-redirect ke /login, exemption tidak melemahkan gating lain", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(new NextRequest(`${ORIGIN}/dashboard`));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("/auth/confirm masih public route seperti sebelumnya -- tidak berubah oleh perbaikan ini", async () => {
    const { updateSession } = await import("./middleware");
    const res = await updateSession(
      new NextRequest(`${ORIGIN}/auth/confirm?token_hash=abc&type=recovery`)
    );

    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });
});
