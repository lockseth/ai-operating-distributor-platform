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
const supabaseMock = {
  auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null })),
    signOut,
  },
  from: vi.fn((table: string) => {
    if (table === "users") {
      return chain({
        data: {
          id: "auth-user-1",
          company_id: "company-1",
          email: "no-membership@waluyo.aodp.test",
          full_name: "No Membership",
          is_active: true,
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
