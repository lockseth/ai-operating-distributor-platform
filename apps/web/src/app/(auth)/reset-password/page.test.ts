// Gate 3E-D2-A-R2 — behavioral tests untuk exchangeCodeForSession(code) di
// /reset-password page.tsx. Link recovery dari template default Supabase
// {{ .ConfirmationURL }} tiba di sini dengan query `code` (PKCE authorization
// code, bukan token_hash) -- lihat komentar di page.tsx untuk alasan empiris
// (flowType hardcode "pkce" di @supabase/ssr createBrowserClient/
// createServerClient). Pola mock sama dengan auth/callback/route.test.ts dan
// lib/auth/get-user.security.test.ts (redirect() di-mock throw agar bisa
// diuji tanpa DB/browser sungguhan).

import { describe, expect, it, vi, beforeEach } from "vitest";

const REDIRECT_MARKER = "NEXT_REDIRECT:";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`${REDIRECT_MARKER}${path}`);
  }),
}));

const exchangeCodeForSession = vi.fn();
const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { exchangeCodeForSession, getUser },
  })),
}));

vi.mock("@/components/auth/reset-password-form", () => ({
  ResetPasswordForm: () => null,
}));

function searchParamsOf(code?: string) {
  return Promise.resolve(code ? { code } : {});
}

describe("/reset-password page recovery code exchange (Gate 3E-D2-A-R2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("code valid -> exchangeCodeForSession dipanggil dengan code itu, lanjut getUser, tidak redirect", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const { default: ResetPasswordPage } = await import("./page");

    const result = await ResetPasswordPage({ searchParams: searchParamsOf("good-code") });

    expect(exchangeCodeForSession).toHaveBeenCalledWith("good-code");
    expect(getUser).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it("code invalid/expired -> exchange gagal -> fail-closed redirect ke /login, pesan Supabase tidak bocor", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "Email link is invalid or has expired" },
    });
    const { default: ResetPasswordPage } = await import("./page");

    await expect(
      ResetPasswordPage({ searchParams: searchParamsOf("bad-code") })
    ).rejects.toThrow(`${REDIRECT_MARKER}/login?error=recovery_failed`);
  });

  it("exchangeCodeForSession melempar exception -> tetap fail-closed, exception tidak bocor ke redirect", async () => {
    exchangeCodeForSession.mockRejectedValue(new Error("network boom: internal detail"));
    const { default: ResetPasswordPage } = await import("./page");

    let caught: unknown;
    try {
      await ResetPasswordPage({ searchParams: searchParamsOf("code-x") });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toBe(`Error: ${REDIRECT_MARKER}/login?error=recovery_failed`);
    expect(String(caught)).not.toContain("internal detail");
  });

  it("code sudah dipakai (Supabase menolak reuse) -> exchange mengembalikan error -> fail-closed, bukan retry diam-diam", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "invalid request: both auth code and code verifier should be non-empty" },
    });
    const { default: ResetPasswordPage } = await import("./page");

    await expect(
      ResetPasswordPage({ searchParams: searchParamsOf("already-used-code") })
    ).rejects.toThrow(`${REDIRECT_MARKER}/login?error=recovery_failed`);
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("tanpa code + tanpa session -> tetap fail-closed seperti sebelumnya (regresi), exchange tidak dipanggil", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { default: ResetPasswordPage } = await import("./page");

    await expect(
      ResetPasswordPage({ searchParams: searchParamsOf() })
    ).rejects.toThrow(`${REDIRECT_MARKER}/login?error=recovery_failed`);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("tanpa code + session valid (jalur must_change_password existing) -> tetap render, exchange tidak dipanggil (regresi)", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u2" } } });
    const { default: ResetPasswordPage } = await import("./page");

    const result = await ResetPasswordPage({ searchParams: searchParamsOf() });

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
