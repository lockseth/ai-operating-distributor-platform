// Gate 3E-C-C2-B4-R2-H1 — behavioral tests untuk GET /api/health, membuktikan
// kontrak response tetap sanitized (tidak pernah membocorkan raw error,
// stack trace, atau detail internal) baik pada kondisi sehat maupun gagal.
// Mock @/lib/supabase/admin supaya bisa diuji tanpa DB sungguhan.

import { describe, expect, it, vi, beforeEach } from "vitest";

const from = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: vi.fn(() => ({ from })),
}));

function buildRequest() {
  return new Request("https://aodp-waluyo-demo.vercel.app/api/health");
}

describe("GET /api/health response sanitization (Gate 3E-C-C2-B4-R2-H1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DB sehat -> status 200, body hanya {status, db_healthy, checked_at}", async () => {
    from.mockReturnValue({
      select: () => ({ limit: () => Promise.resolve({ error: null }) }),
    });
    const { GET } = await import("./route");

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "healthy",
      db_healthy: true,
      checked_at: expect.any(String),
    });
  });

  it("DB error (bukan exception) -> status 503, degraded, pesan error mentah TIDAK bocor ke body", async () => {
    from.mockReturnValue({
      select: () => ({
        limit: () =>
          Promise.resolve({
            error: {
              message: "password authentication failed for user \"postgres\"",
              code: "28P01",
              hint: "internal connection string detail",
            },
          }),
      }),
    });
    const { GET } = await import("./route");

    const res = await GET(buildRequest());
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    expect(res.status).toBe(503);
    expect(body).toEqual({
      status: "degraded",
      db_healthy: false,
      checked_at: expect.any(String),
    });
    expect(bodyText).not.toContain("password authentication failed");
    expect(bodyText).not.toContain("28P01");
    expect(bodyText).not.toContain("connection string");
  });

  it("exception dilempar (network/koneksi putus) -> tetap fail-closed sanitized, tidak crash, tidak bocor stack trace", async () => {
    from.mockImplementation(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 -- internal host detail");
    });
    const { GET } = await import("./route");

    const res = await GET(buildRequest());
    const bodyText = await res.text();

    expect(res.status).toBe(503);
    expect(JSON.parse(bodyText)).toEqual({
      status: "degraded",
      db_healthy: false,
      checked_at: expect.any(String),
    });
    expect(bodyText).not.toContain("ECONNREFUSED");
    expect(bodyText).not.toContain("10.0.0.5");
  });

  it("response TIDAK PERNAH memuat tenant/user id, credential, atau nama env var", async () => {
    from.mockReturnValue({
      select: () => ({ limit: () => Promise.resolve({ error: null }) }),
    });
    const { GET } = await import("./route");

    const res = await GET(buildRequest());
    const bodyText = await res.text();

    expect(bodyText).not.toMatch(/company_id|tenant_id|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE/i);
  });
});
