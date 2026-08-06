// =============================================================================
// Gate 3E-D4-C6 — SupabaseFeatureFlagRepository fail-closed contract.
//
// Setiap kondisi tak terduga (baris tidak ada, kolom malformed, query error,
// exception) HARUS menghasilkan false. Tidak pernah default true pada
// kegagalan apa pun.
// =============================================================================

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseFeatureFlagRepository } from "./repository";

function stubClient(response: { data?: unknown; error?: unknown } | (() => never)): SupabaseClient {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (typeof response === "function") return response();
            return response;
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("SupabaseFeatureFlagRepository -- fail-closed (Gate 3E-D4-C6)", () => {
  it("baris tidak ada (belum pernah di-seed) -> false", async () => {
    const repo = new SupabaseFeatureFlagRepository(stubClient({ data: null, error: null }));
    expect(await repo.isEnabled("telegram_sales_orders")).toBe(false);
  });

  it("query error (mis. network/DB down) -> false, bukan throw", async () => {
    const repo = new SupabaseFeatureFlagRepository(
      stubClient({ data: null, error: { message: "connection refused" } }),
    );
    await expect(repo.isEnabled("telegram_sales_orders")).resolves.toBe(false);
  });

  it("kolom enabled malformed (bukan boolean, mis. string/number/null) -> false", async () => {
    for (const malformed of ["true", 1, null, undefined, {}]) {
      const repo = new SupabaseFeatureFlagRepository(
        stubClient({ data: { enabled: malformed }, error: null }),
      );
      expect(await repo.isEnabled("telegram_sales_orders")).toBe(false);
    }
  });

  it("client melempar exception (mis. dari() gagal) -> false, bukan reject", async () => {
    const throwingClient = {
      from: () => {
        throw new Error("client misconfigured");
      },
    } as unknown as SupabaseClient;
    const repo = new SupabaseFeatureFlagRepository(throwingClient);
    await expect(repo.isEnabled("telegram_sales_orders")).resolves.toBe(false);
  });

  it("enabled = false eksplisit -> false", async () => {
    const repo = new SupabaseFeatureFlagRepository(
      stubClient({ data: { enabled: false }, error: null }),
    );
    expect(await repo.isEnabled("telegram_sales_orders")).toBe(false);
  });

  it("enabled = true eksplisit -> true (satu-satunya jalur menghasilkan true)", async () => {
    const repo = new SupabaseFeatureFlagRepository(
      stubClient({ data: { enabled: true }, error: null }),
    );
    expect(await repo.isEnabled("telegram_sales_orders")).toBe(true);
  });
});
