// =============================================================================
// Gate 3E-D6-B -- unit test lapisan action submitSpecialPriceProposalAction()
// (mock getAuthUser + createClient session-scoped, pola identik
// update-order-status-guard.test.ts). Enforcement UTAMA (role sales strict,
// ownership, tenant, status draft, justification, RPC outcome lengkap) ada
// di database -- RPC submit_special_price_proposal_atomic (migration
// 20260924000001/20260925000001, Gate 3E-D4-C2/C3 LOCKED, DB-backed di
// gate-3e-d4-c2-submit-special-price-proposal.integration.test.ts). Test ini
// membuktikan: (a) guard app-layer menolak SEBELUM RPC dipanggil untuk
// role/justifikasi yang jelas tidak valid, (b) RPC dipanggil lewat client
// session-scoped (bukan admin) dengan parameter yang PERSIS sesuai kontrak --
// tidak ada company_id/actor_id/approver/status yang bisa disuntik client,
// (c) setiap outcome RPC diterjemahkan ke pesan berbeda.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const rpcMock = vi.fn();
const getAuthUserMock = vi.fn();

vi.mock("@/lib/auth/get-user", () => ({
  getAuthUser: () => getAuthUserMock(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ rpc: rpcMock }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function fakeUser(overrides: Partial<{ roles: string[] }> = {}) {
  return {
    id: "actor-1",
    email: "actor@test.local",
    company_id: "company-1",
    company: { id: "company-1", name: "Test Co", slug: "test-co", logo_url: null, subscription_plan: "starter", settings: null },
    roles: overrides.roles ?? ["sales"],
    permissions: [],
    isDemo: false,
  };
}

const validInput = {
  orderId: "order-1",
  items: [{ salesOrderItemId: "item-1", proposedUnitPrice: 9000 }],
  reason: "Permintaan customer lama, volume besar",
  idempotencyKey: "idem-key-1",
};

describe("submitSpecialPriceProposalAction -- guard app-layer sebelum RPC dipanggil", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  it("menolak role non-sales SEBELUM RPC dipanggil sama sekali", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ roles: ["owner"] }));
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction(validInput)).rejects.toThrow(/hanya sales/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("menolak alasan kosong/whitespace SEBELUM RPC dipanggil sama sekali", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction({ ...validInput, reason: "   " })).rejects.toThrow(/alasan pengajuan wajib diisi/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("menolak items kosong SEBELUM RPC dipanggil sama sekali", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction({ ...validInput, items: [] })).rejects.toThrow(/pilih minimal satu item/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("submitSpecialPriceProposalAction -- parameter RPC persis kontrak (tidak ada company_id/actor_id/status dari client)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  it("memanggil submit_special_price_proposal_atomic dengan HANYA 4 parameter kontrak", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "submitted", requires_approval: true, approval_request_id: "req-1", proposal_version: 1, order_status: "pending_owner_approval" }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await submitSpecialPriceProposalAction(validInput);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [rpcName, rpcParams] = rpcMock.mock.calls[0];
    expect(rpcName).toBe("submit_special_price_proposal_atomic");
    expect(Object.keys(rpcParams).sort()).toEqual(["p_idempotency_key", "p_items", "p_reason", "p_sales_order_id"]);
    expect(rpcParams).toEqual({
      p_sales_order_id: "order-1",
      p_items: [{ sales_order_item_id: "item-1", proposed_unit_price: 9000 }],
      p_reason: "Permintaan customer lama, volume besar",
      p_idempotency_key: "idem-key-1",
    });
  });

  it("mengirim identitas actor/tenant HANYA lewat sesi (session-scoped client), bukan sebagai parameter RPC", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "submitted", requires_approval: true, approval_request_id: "req-1", proposal_version: 1, order_status: "pending_owner_approval" }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await submitSpecialPriceProposalAction(validInput);

    const [, rpcParams] = rpcMock.mock.calls[0];
    expect(rpcParams).not.toHaveProperty("p_company_id");
    expect(rpcParams).not.toHaveProperty("p_actor_id");
    expect(rpcParams).not.toHaveProperty("p_status");
    expect(rpcParams).not.toHaveProperty("p_decided_by");
  });
});

describe("submitSpecialPriceProposalAction -- outcome sukses", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  it("outcome 'submitted' resolve dengan requiresApproval=true dan data proposal", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "submitted", requires_approval: true, approval_request_id: "req-1", proposal_version: 1, order_status: "pending_owner_approval" }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    const result = await submitSpecialPriceProposalAction(validInput);
    expect(result).toEqual({
      outcome: "submitted",
      requiresApproval: true,
      approvalRequestId: "req-1",
      proposalVersion: 1,
      orderStatus: "pending_owner_approval",
    });
  });

  it("outcome 'approval_not_required' resolve TANPA error (harga masih dalam batas kebijakan)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "approval_not_required", requires_approval: false, approval_request_id: null, proposal_version: null, order_status: "draft" }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    const result = await submitSpecialPriceProposalAction(validInput);
    expect(result.outcome).toBe("approval_not_required");
    expect(result.requiresApproval).toBe(false);
  });

  it("outcome 'already_exists' (retry idempoten / double-submit dengan key sama) diperlakukan sebagai sukses, bukan error", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "already_exists", requires_approval: true, approval_request_id: "req-1", proposal_version: 1, order_status: "pending_owner_approval" }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction(validInput)).resolves.toMatchObject({ outcome: "already_exists" });
  });
});

describe("submitSpecialPriceProposalAction -- outcome RPC penting diterjemahkan jadi pesan berbeda", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    vi.resetModules();
  });

  const cases: [string, RegExp][] = [
    ["unauthenticated", /sesi login tidak valid/i],
    ["forbidden", /tidak berwenang mengajukan harga khusus/i],
    ["not_found", /order tidak ditemukan/i],
    ["idempotency_conflict", /data berbeda/i],
    ["not_draft", /hanya order berstatus draft/i],
    ["no_items", /pilih minimal satu item/i],
    ["invalid_payload", /data item.*tidak lengkap/i],
    ["duplicate_line", /dipilih lebih dari sekali/i],
    ["line_not_found", /item tidak ditemukan/i],
    ["invalid_price", /harga yang diajukan tidak valid/i],
    ["inactive_product", /produk.*tidak aktif/i],
    ["reason_required", /alasan pengajuan wajib diisi/i],
  ];

  for (const [outcome, expectedMessage] of cases) {
    it(`outcome '${outcome}' -> pesan sesuai`, async () => {
      getAuthUserMock.mockResolvedValue(fakeUser());
      rpcMock.mockResolvedValue({
        data: [{ result_outcome: outcome, requires_approval: null, approval_request_id: null, proposal_version: null, order_status: null }],
        error: null,
      });
      const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

      await expect(submitSpecialPriceProposalAction(validInput)).rejects.toThrow(expectedMessage);
    });
  }

  it("outcome tak dikenal tetap jadi error eksplisit (bukan silent success)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({
      data: [{ result_outcome: "some_future_outcome", requires_approval: null, approval_request_id: null, proposal_version: null, order_status: null }],
      error: null,
    });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction(validInput)).rejects.toThrow(/gagal mengajukan harga khusus/i);
  });

  it("error dari RPC layer (mis. network/permission Postgres) diteruskan sebagai Error", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser());
    rpcMock.mockResolvedValue({ data: null, error: { message: "permission denied for function submit_special_price_proposal_atomic" } });
    const { submitSpecialPriceProposalAction } = await import("./special-price-proposal-actions");

    await expect(submitSpecialPriceProposalAction(validInput)).rejects.toThrow(/permission denied/i);
  });
});
