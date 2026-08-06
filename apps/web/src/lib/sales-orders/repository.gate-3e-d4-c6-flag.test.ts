// =============================================================================
// Gate 3E-D4-C6 — SupabaseSalesOrderRepository.hasSalesOrderCapability
// menggabungkan DUA syarat independen: role 'sales' DAN kill switch global
// telegram_sales_orders. Test ini membuktikan:
//   1. Flag OFF short-circuit SEBELUM query role (user_roles) sama sekali --
//      tidak ada jalur bypass lewat role apa pun saat flag mati.
//   2. Mekanisme generik lintas identity -- DUA user Sales berbeda (user id,
//      nama, tenant berbeda) diuji, membuktikan tidak ada allowlist/hardcode
//      per-user.
//   3. Flag ON + role bukan sales tetap ditolak (dua syarat, bukan OR).
// =============================================================================

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseSalesOrderRepository } from "./repository";

interface FakeRoleRow {
  role: { name: string } | null;
}

function stubClient(options: {
  flagRow: { enabled: unknown } | null | undefined;
  flagError?: unknown;
  rolesByUserCompany: Record<string, FakeRoleRow[]>;
}): { client: SupabaseClient; calledTables: string[] } {
  const calledTables: string[] = [];

  const client = {
    from: (table: string) => {
      calledTables.push(table);

      if (table === "platform_feature_flags") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: options.flagRow ?? null,
                error: options.flagError ?? null,
              }),
            }),
          }),
        };
      }

      if (table === "user_roles") {
        let userId = "";
        let companyId = "";
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === "user_id") userId = val;
              if (col === "company_id") companyId = val;
              const chain = {
                eq: (col2: string, val2: string) => {
                  if (col2 === "user_id") userId = val2;
                  if (col2 === "company_id") companyId = val2;
                  return Promise.resolve({
                    data: options.rolesByUserCompany[`${userId}:${companyId}`] ?? [],
                    error: null,
                  });
                },
                then: (resolve: (v: unknown) => void) =>
                  resolve({
                    data: options.rolesByUserCompany[`${userId}:${companyId}`] ?? [],
                    error: null,
                  }),
              };
              return chain;
            },
          }),
        };
      }

      throw new Error(`unexpected table queried in test stub: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, calledTables };
}

describe("Gate 3E-D4-C6: hasSalesOrderCapability -- flag global + role, generik lintas identity", () => {
  it("flag OFF -> ditolak untuk identity Sales pertama (user-A), user_roles TIDAK PERNAH di-query (short-circuit)", async () => {
    const { client, calledTables } = stubClient({
      flagRow: { enabled: false },
      rolesByUserCompany: { "user-a:company-1": [{ role: { name: "sales" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    const result = await repo.hasSalesOrderCapability("user-a", "company-1");

    expect(result).toBe(false);
    expect(calledTables).toEqual(["platform_feature_flags"]);
    expect(calledTables).not.toContain("user_roles");
  });

  it("flag OFF -> ditolak untuk identity Sales KEDUA yang sama sekali berbeda (user-B, tenant lain) -- bukti mekanisme tidak bergantung user id/nama/tenant", async () => {
    const { client, calledTables } = stubClient({
      flagRow: { enabled: false },
      rolesByUserCompany: { "user-b-different:company-99": [{ role: { name: "sales" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    const result = await repo.hasSalesOrderCapability("user-b-different", "company-99");

    expect(result).toBe(false);
    expect(calledTables).toEqual(["platform_feature_flags"]);
  });

  it("flag hilang (baris tidak ada) -> ditolak juga untuk identity Sales kedua, tanpa query role", async () => {
    const { client, calledTables } = stubClient({
      flagRow: null,
      rolesByUserCompany: { "user-b-different:company-99": [{ role: { name: "sales" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    expect(await repo.hasSalesOrderCapability("user-b-different", "company-99")).toBe(false);
    expect(calledTables).not.toContain("user_roles");
  });

  it("flag ON + role sales -> DIIZINKAN untuk identity pertama (user-A)", async () => {
    const { client } = stubClient({
      flagRow: { enabled: true },
      rolesByUserCompany: { "user-a:company-1": [{ role: { name: "sales" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    expect(await repo.hasSalesOrderCapability("user-a", "company-1")).toBe(true);
  });

  it("flag ON + role sales -> DIIZINKAN untuk identity KEDUA yang berbeda (user-B, tenant lain) -- mekanisme generik, bukan allowlist satu user", async () => {
    const { client } = stubClient({
      flagRow: { enabled: true },
      rolesByUserCompany: { "user-b-different:company-99": [{ role: { name: "sales" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    expect(await repo.hasSalesOrderCapability("user-b-different", "company-99")).toBe(true);
  });

  it("flag ON tapi role BUKAN sales (mis. owner) -> tetap ditolak -- dua syarat wajib TRUE bersamaan, bukan OR", async () => {
    const { client } = stubClient({
      flagRow: { enabled: true },
      rolesByUserCompany: { "user-owner:company-1": [{ role: { name: "owner" } }] },
    });
    const repo = new SupabaseSalesOrderRepository(client);

    expect(await repo.hasSalesOrderCapability("user-owner", "company-1")).toBe(false);
  });
});
