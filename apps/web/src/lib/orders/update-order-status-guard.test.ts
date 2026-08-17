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

    await updateOrderStatusAction("order-1", "processing");
    expect(rpcMock).toHaveBeenCalledWith(
      "update_sales_order_status_atomic",
      expect.objectContaining({ p_new_status: "processing" })
    );
  });

  it("outcome RPC 'paid_locked' diterjemahkan jadi error eksplisit (bukan silent success)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "paid_locked" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "processing")).rejects.toThrow(/sudah berstatus paid/i);
  });

  it("outcome RPC 'payment_workflow_required' tetap diterjemahkan jadi error eksplisit, bukan silent success", async () => {
    // Skenario defensif: app-layer guard sudah menolak newStatus "paid"
    // sebelum RPC dipanggil (lihat test pertama), tapi seandainya RPC tetap
    // mengembalikan outcome ini (mis. race/versi lama), action tidak boleh
    // memperlakukannya sebagai sukses.
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "payment_workflow_required" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "processing")).rejects.toThrow(/payment workflow terverifikasi/i);
  });

  it("menolak target 'invoiced' SEBELUM admin.rpc() dipanggil sama sekali", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "invoiced")).rejects.toThrow(
      /issuance invoice canonical/i
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("owner sekalipun tidak bisa melewati guard invoiced -- guard tidak bergantung role", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ roles: ["owner"], permissions: ["orders.update", "orders.manage"] }));
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "invoiced")).rejects.toThrow(
      /issuance invoice canonical/i
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("outcome RPC 'invoiced_locked' diterjemahkan jadi error eksplisit (bukan silent success)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "invoiced_locked" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "processing")).rejects.toThrow(/sudah berstatus invoiced/i);
  });

  it("outcome RPC 'invoice_issuance_required' tetap diterjemahkan jadi error eksplisit, bukan silent success", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "invoice_issuance_required" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "processing")).rejects.toThrow(/issuance invoice canonical/i);
  });

  it("outcome RPC 'delivery_override_role_required' (Gate P4.07) diterjemahkan jadi error eksplisit, bukan silent success", async () => {
    // Enforcement UTAMA ada di database (migration 20261008000001, guard role
    // owner/manager/admin/super_admin utk target delivering/delivered) --
    // dibuktikan DB-backed lewat psql manual (lihat TRACKER.md). Test ini
    // membuktikan lapisan action menerjemahkan outcome-nya dengan benar,
    // bukan memperlakukannya sebagai sukses.
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "delivery_override_role_required" }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "delivering")).rejects.toThrow(/Owner\/Manager\/Admin/i);
  });
});

// =============================================================================
// Gate 3E-D4-C4 -- target "confirmed" WAJIB reroute ke confirm_sales_order_atomic
// (bukan lagi update_sales_order_status_atomic sama sekali). Enforcement UTAMA
// ada di database (migration 20260926000001, Guard G pada update_sales_order_
// status_atomic + Guard 1-3 pada confirm_sales_order_atomic) -- dibuktikan
// DB-backed di gate-3e-d4-c4-confirmation-enforcement.integration.test.ts.
// Test ini membuktikan lapisan action memanggil RPC yang BENAR dan
// menerjemahkan outcome barunya dengan benar.
// =============================================================================
describe("updateOrderStatusAction -- target 'confirmed' reroute ke confirm_sales_order_atomic (Gate 3E-D4-C4)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  it("target 'confirmed' memanggil confirm_sales_order_atomic, BUKAN update_sales_order_status_atomic", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "confirmed", already_confirmed: false }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await updateOrderStatusAction("order-1", "confirmed");
    expect(rpcMock).toHaveBeenCalledWith(
      "confirm_sales_order_atomic",
      expect.objectContaining({ p_order_id: "order-1" })
    );
    expect(rpcMock).not.toHaveBeenCalledWith("update_sales_order_status_atomic", expect.anything());
  });

  it("outcome 'already_confirmed' diperlakukan sebagai sukses (idempotent)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "already_confirmed", already_confirmed: true }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).resolves.toBeUndefined();
  });

  it("outcome 'invalid_order_state' (mis. order pending_owner_approval) diterjemahkan jadi error eksplisit", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "invalid_order_state", already_confirmed: false }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/tidak dapat dikonfirmasi/i);
  });

  it("outcome 'pending_approval_exists' diterjemahkan jadi error eksplisit", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "pending_approval_exists", already_confirmed: false }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/menunggu keputusan owner/i);
  });

  it("outcome 'unapproved_special_price' diterjemahkan jadi error eksplisit", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "unapproved_special_price", already_confirmed: false }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/belum\/tidak disetujui owner/i);
  });

  it("outcome 'approval_snapshot_mismatch' diterjemahkan jadi error eksplisit", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: [{ result_outcome: "approval_snapshot_mismatch", already_confirmed: false }], error: null });
    const { updateOrderStatusAction } = await import("./actions");

    await expect(updateOrderStatusAction("order-1", "confirmed")).rejects.toThrow(/berubah setelah disetujui owner/i);
  });
});
