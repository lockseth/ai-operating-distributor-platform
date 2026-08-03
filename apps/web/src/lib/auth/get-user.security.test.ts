import { describe, expect, it, vi, beforeEach } from "vitest";

// =============================================================================
// Gate 3C: user dengan sesi Supabase Auth valid + profile public.users aktif,
// tapi TANPA satu pun baris user_roles (tidak ada canonical membership), harus
// gagal-tutup ke /login -- BUKAN diloloskan dengan roles=[] yang lalu
// (sebelum fix ini) membuat getPrimaryRole([]) fallback diam-diam ke "sales"
// dan menyebabkan redirect loop /dashboard <-> /dashboard/sales.
// =============================================================================

const REDIRECT_MARKER = "NEXT_REDIRECT:";

function chain(result: { data: unknown }) {
  const obj: Record<string, unknown> = {};
  obj.select = () => obj;
  obj.eq = () => obj;
  obj.in = () => obj;
  obj.order = () => obj;
  obj.maybeSingle = () => Promise.resolve(result);
  obj.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return obj;
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`${REDIRECT_MARKER}${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
}));

vi.mock("@/lib/demo/config", () => ({
  DEMO_MODE_COOKIE: "aodp_demo_mode",
  isDemoModeAllowed: () => false,
}));

const signOut = vi.fn(async () => ({ error: null }));
const rpc = vi.fn(async () => ({ data: [{ result_outcome: "cleared" }], error: null }));
const supabaseMock = {
  auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null })),
    signOut,
  },
  rpc,
  from: vi.fn((table: string) => {
    if (table === "users") {
      return chain({
        data: {
          id: "auth-user-1",
          company_id: "company-1",
          email: "no-membership@waluyo.aodp.test",
          full_name: "No Membership",
          is_active: true,
          must_change_password: false,
        },
      });
    }
    if (table === "companies") {
      return chain({
        data: {
          id: "company-1",
          name: "PT. Sumber Warna Alam Sudiada",
          slug: "waluyo",
          logo_url: null,
          subscription_plan: "growth",
          settings: null,
        },
      });
    }
    if (table === "user_roles") {
      return chain({ data: [] }); // <-- zero membership rows, the case under test
    }
    return chain({ data: [] });
  }),
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

describe("getAuthUser fail-closed untuk user tanpa membership (Gate 3C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.auth.getUser = vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null }));
    supabaseMock.auth.signOut = signOut;
  });

  it("profile aktif + zero user_roles -> signOut() dipanggil lalu redirect ke /login (bukan fallback ke role default)", async () => {
    const { getAuthUser } = await import("./get-user");

    await expect(getAuthUser()).rejects.toThrow(`${REDIRECT_MARKER}/login`);
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Gate 3E-C-C1: auth user valid TANPA baris public.users sama sekali (signup
// terputus sebelum provision_first_owner() dipanggil) harus di-redirect ke
// /signup -- BUKAN /login. Sebelum fix ini, redirect ke /login menyebabkan
// redirect loop tak berujung: middleware.ts mengarahkan authenticated user di
// /login balik ke /dashboard, yang memanggil getAuthUser() ini lagi, yang
// menemukan !profile lagi. /signup adalah satu-satunya halaman yang
// menangani state ini (evaluateSession() di signup-form.tsx). Sesi TIDAK
// boleh di-signOut di jalur ini (beda dari Gate 3C di atas) karena
// provision_first_owner() butuh sesi itu untuk melanjutkan.
// =============================================================================

describe("getAuthUser resume-onboarding untuk auth user tanpa profile sama sekali (Gate 3E-C-C1 / G4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.auth.getUser = vi.fn(async () => ({ data: { user: { id: "auth-user-orphan" } }, error: null }));
    supabaseMock.auth.signOut = signOut;
    supabaseMock.from = vi.fn((table: string) => {
      if (table === "users") {
        return chain({ data: null }); // <-- zero public.users row, the case under test
      }
      return chain({ data: [] });
    });
  });

  it("profile tidak ada sama sekali -> redirect ke /signup (bukan /login, mencegah redirect loop)", async () => {
    const { getAuthUser } = await import("./get-user");

    await expect(getAuthUser()).rejects.toThrow(`${REDIRECT_MARKER}/signup`);
  });

  it("sesi TIDAK di-signOut -- dibutuhkan untuk melanjutkan provision_first_owner() via auth.uid()", async () => {
    const { getAuthUser } = await import("./get-user");

    await expect(getAuthUser()).rejects.toThrow();
    expect(signOut).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Gate 3E-C-C2-B1: user dengan must_change_password = TRUE (dibuat owner
// dengan temporary password) tidak boleh mengakses dashboard sampai password
// sungguh diganti. getAuthUser() memanggil complete_mandatory_password_change()
// (RPC, auth.uid()-based) untuk self-heal; hanya redirect ke /reset-password
// bila RPC MEMBUKTIKAN password belum berubah. Sesi TIDAK di-signOut --
// reset-password-form.tsx butuh sesi itu untuk memanggil updateUser().
// =============================================================================

function fullProfileMock(overrides: { must_change_password: boolean }) {
  return vi.fn((table: string) => {
    if (table === "users") {
      return chain({
        data: {
          id: "auth-user-mcp",
          company_id: "company-1",
          email: "new.admin@waluyo.aodp.test",
          full_name: "New Admin",
          is_active: true,
          must_change_password: overrides.must_change_password,
        },
      });
    }
    if (table === "companies") {
      return chain({
        data: {
          id: "company-1",
          name: "PT. Sumber Warna Alam Sudiada",
          slug: "waluyo",
          logo_url: null,
          subscription_plan: "growth",
          settings: null,
        },
      });
    }
    if (table === "user_roles") {
      return chain({ data: [{ role_id: "role-admin" }] });
    }
    if (table === "roles") {
      return chain({ data: [{ name: "admin" }] });
    }
    if (table === "role_permissions") {
      return chain({ data: [] });
    }
    return chain({ data: [] });
  });
}

describe("getAuthUser mandatory password gate (Gate 3E-C-C2-B1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseMock.auth.getUser = vi.fn(async () => ({ data: { user: { id: "auth-user-mcp" } }, error: null }));
    supabaseMock.auth.signOut = signOut;
  });

  it("must_change_password = TRUE dan RPC membuktikan password BELUM diganti -> redirect /reset-password, sesi TIDAK di-signOut", async () => {
    supabaseMock.from = fullProfileMock({ must_change_password: true });
    supabaseMock.rpc = vi.fn(async () => ({ data: [{ result_outcome: "password_not_yet_changed" }], error: null }));

    const { getAuthUser } = await import("./get-user");

    await expect(getAuthUser()).rejects.toThrow(`${REDIRECT_MARKER}/reset-password`);
    expect(supabaseMock.rpc).toHaveBeenCalledWith("complete_mandatory_password_change");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("must_change_password = TRUE dan RPC berhasil membersihkan flag ('cleared') -> akses dashboard dilanjutkan seperti biasa (tidak redirect)", async () => {
    supabaseMock.from = fullProfileMock({ must_change_password: true });
    supabaseMock.rpc = vi.fn(async () => ({ data: [{ result_outcome: "cleared" }], error: null }));

    const { getAuthUser } = await import("./get-user");

    const result = await getAuthUser();
    expect(result.id).toBe("auth-user-mcp");
    expect(result.roles).toEqual(["admin"]);
    expect(supabaseMock.rpc).toHaveBeenCalledWith("complete_mandatory_password_change");
  });

  it("must_change_password = FALSE -> RPC tidak pernah dipanggil (regresi: user normal tidak terpengaruh)", async () => {
    supabaseMock.from = fullProfileMock({ must_change_password: false });
    supabaseMock.rpc = vi.fn(async () => ({ data: [{ result_outcome: "already_cleared" }], error: null }));

    const { getAuthUser } = await import("./get-user");

    const result = await getAuthUser();
    expect(result.id).toBe("auth-user-mcp");
    expect(supabaseMock.rpc).not.toHaveBeenCalled();
  });
});
