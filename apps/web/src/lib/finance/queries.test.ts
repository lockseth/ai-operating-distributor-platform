// =============================================================================
// Unit test -- Gate 2I.1 read model (lib/finance/queries.ts).
//
// Pure-function coverage (tanpa DB): access guard, age calculation, ordering
// determinism. Plus satu test dengan fake Supabase client (thenable builder,
// bukan mock library baru) yang membuktikan kegagalan SATU kategori tidak
// pernah ditelan menjadi array kosong pada getFinanceActionQueue -- kategori
// gagal wajib muncul di failedCategories, kategori lain tetap terisi normal.
// =============================================================================

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeAgeDays,
  sortActionQueueItems,
  hasFinanceWorkspaceAccess,
  getFinanceActionQueue,
  FINANCE_WORKSPACE_PERMISSION,
  type FinanceActionQueueItem,
} from "./queries";

describe("hasFinanceWorkspaceAccess", () => {
  it("true bila permissions memuat receivable.view", () => {
    expect(hasFinanceWorkspaceAccess(["receivable.view", "orders.view"])).toBe(true);
  });

  it("false bila permissions tidak memuat receivable.view (mis. sales)", () => {
    expect(hasFinanceWorkspaceAccess(["orders.view", "orders.create"])).toBe(false);
  });

  it("konstanta permission sesuai migration Gate 2A (bukan dikarang)", () => {
    expect(FINANCE_WORKSPACE_PERMISSION).toBe("receivable.view");
  });
});

describe("computeAgeDays", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");

  it("null untuk input null/undefined", () => {
    expect(computeAgeDays(null, now)).toBeNull();
    expect(computeAgeDays(undefined, now)).toBeNull();
  });

  it("null untuk tanggal tidak valid", () => {
    expect(computeAgeDays("bukan-tanggal", now)).toBeNull();
  });

  it("menghitung selisih hari dibulatkan ke bawah", () => {
    expect(computeAgeDays("2026-08-15T00:00:00.000Z", now)).toBe(5);
    expect(computeAgeDays("2026-08-19T23:00:00.000Z", now)).toBe(0);
  });

  it("tidak pernah negatif untuk tanggal di masa depan (clamped ke 0)", () => {
    expect(computeAgeDays("2026-08-25T00:00:00.000Z", now)).toBe(0);
  });
});

function makeItem(overrides: Partial<FinanceActionQueueItem>): FinanceActionQueueItem {
  return {
    id: "x",
    category: "invoice_overdue",
    categoryLabel: "Invoice jatuh tempo/overdue",
    entityLabel: "Toko A",
    referenceNumber: "INV-1",
    amount: 100000,
    statusCode: "outstanding",
    statusDomain: "invoice",
    eventDate: null,
    ageDays: null,
    ownerOnly: false,
    roleNote: "Owner/Finance",
    ...overrides,
  };
}

describe("sortActionQueueItems", () => {
  it("urut berdasarkan priority kategori (invoice_overdue sebelum refund_pending)", () => {
    const items = [
      makeItem({ id: "refund", category: "refund_pending" }),
      makeItem({ id: "invoice", category: "invoice_overdue" }),
    ];
    const sorted = sortActionQueueItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["invoice", "refund"]);
  });

  it("dalam priority yang sama, urut berdasarkan ageDays menurun (paling lama dulu)", () => {
    const items = [
      makeItem({ id: "young", category: "invoice_overdue", ageDays: 2 }),
      makeItem({ id: "old", category: "invoice_overdue", ageDays: 30 }),
    ];
    const sorted = sortActionQueueItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["old", "young"]);
  });

  it("item tanpa ageDays (null) ditempatkan setelah item yang punya umur", () => {
    const items = [
      makeItem({ id: "no-age", category: "invoice_overdue", ageDays: null }),
      makeItem({ id: "has-age", category: "invoice_overdue", ageDays: 1 }),
    ];
    const sorted = sortActionQueueItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["has-age", "no-age"]);
  });

  it("tie-breaker stabil berdasarkan id ketika priority dan ageDays sama", () => {
    const items = [
      makeItem({ id: "b", category: "invoice_overdue", ageDays: 5 }),
      makeItem({ id: "a", category: "invoice_overdue", ageDays: 5 }),
    ];
    const sorted = sortActionQueueItems(items);
    expect(sorted.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("tidak memutasi array input (immutable sort)", () => {
    const items = [makeItem({ id: "b" }), makeItem({ id: "a" })];
    const original = [...items];
    sortActionQueueItems(items);
    expect(items).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// Fake Supabase client -- thenable query builder minimal, bukan dependency
// baru (tidak menambah mocking library). Setiap .from(table) mengembalikan
// builder yang me-resolve konfigurasi respons per nama tabel.
// ---------------------------------------------------------------------------

type FakeTableResponse = { data?: unknown[]; error?: { message: string } | null };

function createFakeSupabase(tableResponses: Record<string, FakeTableResponse>): SupabaseClient {
  const from = (table: string) => {
    const response = tableResponses[table] ?? { data: [], error: null };
    const builder = {
      select: () => builder,
      eq: () => builder,
      not: () => builder,
      lte: () => builder,
      gte: () => builder,
      order: () => builder,
      limit: () => builder,
      in: () => builder,
      then: (
        onFulfilled: (value: { data: unknown[]; error: { message: string } | null }) => unknown
      ) => onFulfilled({ data: response.data ?? [], error: response.error ?? null }),
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

describe("getFinanceActionQueue -- kegagalan satu kategori tidak ditelan jadi nol", () => {
  it("kategori yang error masuk failedCategories, kategori lain tetap terisi", async () => {
    const fake = createFakeSupabase({
      invoices: {
        data: [
          {
            id: "inv-1",
            invoice_number: "INV-001",
            due_date: "2020-01-01",
            customers: { name: "Toko Uji" },
          },
        ],
        error: null,
      },
      invoice_receivable_balances: {
        data: [{ invoice_id: "inv-1", outstanding_balance: 50000, financial_status: "outstanding" }],
        error: null,
      },
      payment_reconciliation_exceptions: { data: undefined, error: { message: "simulasi query gagal" } },
    });

    const result = await getFinanceActionQueue("company-a", fake);

    expect(result.failedCategories).toEqual(["reconciliation_exception"]);
    expect(result.items.some((i) => i.category === "invoice_overdue")).toBe(true);
    expect(result.items.some((i) => i.category === "reconciliation_exception")).toBe(false);
  });

  it("semua kategori sukses kosong -> items kosong DAN failedCategories kosong (beda dari gagal)", async () => {
    const fake = createFakeSupabase({});
    const result = await getFinanceActionQueue("company-a", fake);
    expect(result.items).toEqual([]);
    expect(result.failedCategories).toEqual([]);
  });
});
