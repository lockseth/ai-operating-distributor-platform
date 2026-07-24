// =============================================================================
// Payment Status Integrity Containment Gate -- defense-in-depth di server
// action updateOrderStatusAction(). Enforcement UTAMA ada di database (RPC
// update_sales_order_status_atomic, migration 20260824000001) -- dibuktikan
// terpisah di actions.integration.test.ts (DB-backed) dan
// status-lock-migration.security.test.ts (static). Test ini membuktikan
// lapisan action menolak SEBELUM admin client/RPC dipanggil sama sekali,
// termasuk untuk actor berperan owner (tidak ada bypass berbasis role).
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const rpcMock = vi.fn();
const getAuthUserMock = vi.fn();

vi.mock("@/lib/auth/get-user", () => ({
  getAuthUser: () => getAuthUserMock(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({ rpc: rpcMock }),
}));

// actions.ts juga meng-import @/lib/supabase/server (dipakai createOrderAction,
// tidak dipanggil oleh updateOrderStatusAction) -- di-mock juga supaya modul
// tidak transitively meng-import next/headers di luar request context Next.js.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

function fakeUser(overrides: Partial<{ roles: string[]; permissions: string[] }> = {}) {
  return {
    id: "actor-1",
    email: "actor@test.local",
    company_id: "company-1",
    company: { id: "company-1", name: "Test Co", slug: "test-co", logo_url: null, subscription_plan: "starter", settings: null },
    roles: overrides.roles ?? ["owner"],
    permissions: overrides.permissions ?? ["orders.update"],
    isDemo: false,
  };
}

describe("updateOrderStatusAction -- defense-in-depth guard paid", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  it("menolak target 'paid' SEBELUM admin.rpc() dipanggil sama sekali", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "paid")).rejects.toThrow(
      /payment workflow terverifikasi/i
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("owner sekalipun tidak bisa melewati -- guard tidak bergantung role", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ roles: ["owner"], permissions: ["orders.update", "orders.manage"] }));
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "paid")).rejects.toThrow(
      /payment workflow terverifikasi/i
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("status lain yang legal tetap memanggil RPC seperti biasa (tidak rusak oleh guard)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "updated" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await updateOrderStatusAction("order-1", "confirmed");
    expect(rpcMock).toHaveBeenCalledWith(
      "update_sales_order_status_atomic",
      expect.objectContaining({ p_new_status: "confirmed" })
    );
  });

  it("outcome RPC 'paid_locked' diterjemahkan jadi error eksplisit (bukan silent success)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "paid_locked" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/sudah berstatus paid/i);
  });

  it("outcome RPC 'payment_workflow_required' tetap diterjemahkan jadi error eksplisit, bukan silent success", async () => {
    // Skenario defensif: app-layer guard sudah menolak newStatus "paid"
    // sebelum RPC dipanggil (lihat test pertama), tapi seandainya RPC tetap
    // mengembalikan outcome ini (mis. race/versi lama), action tidak boleh
    // memperlakukannya sebagai sukses.
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "payment_workflow_required" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/payment workflow terverifikasi/i);
  });
});
