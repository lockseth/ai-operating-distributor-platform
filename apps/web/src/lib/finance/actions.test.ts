// =============================================================================
// Gate 2I.2 -- Server action wrapper guard test (apps/web/src/lib/finance/
// actions.ts), pola sama apps/web/src/lib/orders/update-order-status-guard.test.ts
// (mock getAuthUser/getAdminClient/next-cache -- tidak butuh Next.js request
// context nyata maupun DB). RPC canonical Gate 2C/2D/2E sendiri (nama fungsi,
// FORBIDDEN/tenant/idempotency/concurrency di level database) SUDAH dibuktikan
// di collection-promise-foundation.integration.test.ts,
// payment-receipt-proof-allocation.integration.test.ts, dan
// payment-reconciliation-exception.integration.test.ts (regression, tidak
// diulang di sini). Test ini membuktikan lapisan actions.ts SAJA: (1) guard
// permission menolak SEBELUM RPC dipanggil (FIN-02-04/FIN-08-01), (2) nama
// RPC dan nama parameter yang dikirim persis sama dengan signature migration
// (regresi terhadap salah ketik param), (3) idempotency key diteruskan apa
// adanya tanpa di-generate ulang oleh action (FIN-10-01), (4) error RPC
// dipetakan ke pesan Indonesia, kode mentah tidak bocor (FIN-10-03/FIN-11-01/
// FIN-12-03), (5) hasil out_already_exists diteruskan apa adanya untuk UI
// idempotent no-op (FIN-09-04/FIN-10-04).
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const rpcMock = vi.fn();
const getAuthUserMock = vi.fn();
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth/get-user", () => ({
  getAuthUser: () => getAuthUserMock(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({ rpc: rpcMock }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

function fakeUser(overrides: Partial<{ permissions: string[] }> = {}) {
  return {
    id: "actor-1",
    email: "actor@test.local",
    company_id: "company-1",
    company: { id: "company-1", name: "Test Co", slug: "test-co", logo_url: null, subscription_plan: "starter", settings: null },
    roles: ["finance"],
    permissions: overrides.permissions ?? [],
    isDemo: false,
  };
}

describe("Gate 2I.2 finance actions -- permission guard menolak sebelum RPC dipanggil (FIN-02-04/FIN-08-01)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("recordCollectionActivityAction menolak actor tanpa collection.record", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { recordCollectionActivityAction } = await import("./actions");
    await expect(
      recordCollectionActivityAction({ invoiceId: "inv-1", channel: "phone", activityType: "attempt" })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("createPromiseToPayAction/correctPromiseToPayAction/cancelPromiseToPayAction/markPromiseBrokenAction menolak actor tanpa collection.promise", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { createPromiseToPayAction, correctPromiseToPayAction, cancelPromiseToPayAction, markPromiseBrokenAction } = await import(
      "./actions"
    );

    await expect(
      createPromiseToPayAction({ invoiceId: "inv-1", promisedAmount: 1000, promisedDate: "2099-01-01", channel: "phone" })
    ).rejects.toThrow(/tidak punya akses/i);
    await expect(
      correctPromiseToPayAction({ promiseId: "p-1", newPromisedAmount: 1000, newPromisedDate: "2099-01-01", reason: "x" })
    ).rejects.toThrow(/tidak punya akses/i);
    await expect(cancelPromiseToPayAction({ promiseId: "p-1", reason: "x" })).rejects.toThrow(/tidak punya akses/i);
    await expect(markPromiseBrokenAction({ promiseId: "p-1" })).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("recordVerifiedPaymentAction menolak actor Manager tanpa payment.record (Manager punya akses lihat, bukan akses catat -- kontrak §4)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["receivable.view"] }));
    const { recordVerifiedPaymentAction } = await import("./actions");
    await expect(
      recordVerifiedPaymentAction({
        method: "cash",
        amount: 1000,
        proofs: [{ proofType: "cash_receipt", objectReference: "ref" }],
        allocations: [{ invoiceId: "inv-1", amount: 1000 }],
      })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("reconcileVerifiedPaymentAction/correctPaymentReconciliationAction menolak actor tanpa payment.reconcile", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { reconcileVerifiedPaymentAction, correctPaymentReconciliationAction } = await import("./actions");

    await expect(reconcileVerifiedPaymentAction({ paymentReceiptId: "receipt-1" })).rejects.toThrow(/tidak punya akses/i);
    await expect(
      correctPaymentReconciliationAction({ reconciliationId: "recon-1", paymentReceiptId: "receipt-1", reason: "x" })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("Gate 2I.2 finance actions -- RPC canonical dipanggil dengan nama & parameter persis migration", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("recordCollectionActivityAction memanggil record_collection_activity dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.record"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_activity_id: "act-1", out_activity_type: "attempt", out_outcome: null, out_already_exists: false }],
      error: null,
    });
    const { recordCollectionActivityAction } = await import("./actions");

    await recordCollectionActivityAction({ invoiceId: "inv-1", channel: "phone", activityType: "attempt", idempotencyKey: "key-1" });

    expect(rpcMock).toHaveBeenCalledWith("record_collection_activity", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_invoice_id: "inv-1",
      p_channel: "phone",
      p_activity_type: "attempt",
      p_outcome: null,
      p_reported_amount: null,
      p_note: null,
      p_idempotency_key: "key-1",
    });
  });

  it("createPromiseToPayAction memanggil create_promise_to_pay dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.promise"] }));
    rpcMock.mockResolvedValue({ data: [{ out_promise_id: "p-1", out_status: "open" }], error: null });
    const { createPromiseToPayAction } = await import("./actions");

    await createPromiseToPayAction({
      invoiceId: "inv-1",
      promisedAmount: 5000,
      promisedDate: "2099-01-01",
      channel: "phone",
      idempotencyKey: "key-2",
    });

    expect(rpcMock).toHaveBeenCalledWith("create_promise_to_pay", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_invoice_id: "inv-1",
      p_promised_amount: 5000,
      p_promised_date: "2099-01-01",
      p_channel: "phone",
      p_note: null,
      p_idempotency_key: "key-2",
    });
  });

  it("correctPromiseToPayAction memanggil correct_promise_to_pay dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.promise"] }));
    rpcMock.mockResolvedValue({ data: [{ out_new_promise_id: "p-2", out_old_promise_id: "p-1" }], error: null });
    const { correctPromiseToPayAction } = await import("./actions");

    await correctPromiseToPayAction({
      promiseId: "p-1",
      newPromisedAmount: 8000,
      newPromisedDate: "2099-03-01",
      reason: "Perpanjangan tanggal",
      idempotencyKey: "key-3",
    });

    expect(rpcMock).toHaveBeenCalledWith("correct_promise_to_pay", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_promise_id: "p-1",
      p_new_promised_amount: 8000,
      p_new_promised_date: "2099-03-01",
      p_reason: "Perpanjangan tanggal",
      p_idempotency_key: "key-3",
    });
  });

  it("cancelPromiseToPayAction memanggil cancel_promise_to_pay dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.promise"] }));
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { cancelPromiseToPayAction } = await import("./actions");

    await cancelPromiseToPayAction({ promiseId: "p-1", reason: "Customer batal", idempotencyKey: "key-4" });

    expect(rpcMock).toHaveBeenCalledWith("cancel_promise_to_pay", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_promise_id: "p-1",
      p_reason: "Customer batal",
      p_idempotency_key: "key-4",
    });
  });

  it("recordVerifiedPaymentAction memanggil record_verified_payment_atomic dengan parameter & bentuk proofs/allocations persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.record"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_payment_receipt_id: "receipt-1", out_already_exists: false, out_allocations: [] }],
      error: null,
    });
    const { recordVerifiedPaymentAction } = await import("./actions");

    await recordVerifiedPaymentAction({
      method: "bank_transfer",
      amount: 10000,
      proofs: [{ proofType: "bank_transfer_receipt", objectReference: "storage://proofs/x.jpg", metadata: { size: 1 } }],
      allocations: [{ invoiceId: "inv-1", amount: 10000 }],
      transferReference: "TRF-1",
      idempotencyKey: "key-5",
    });

    expect(rpcMock).toHaveBeenCalledWith("record_verified_payment_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_method: "bank_transfer",
      p_amount: 10000,
      p_proofs: [{ proof_type: "bank_transfer_receipt", object_reference: "storage://proofs/x.jpg", metadata: { size: 1 } }],
      p_allocations: [{ invoice_id: "inv-1", amount: 10000 }],
      p_transfer_reference: "TRF-1",
      p_idempotency_key: "key-5",
    });
  });

  it("reconcileVerifiedPaymentAction memanggil reconcile_verified_payment dengan parameter persis (default method manual)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.reconcile"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_reconciliation_id: "recon-1", out_classification: "matched", out_total_allocated: "1000", out_unallocated_amount: "0", out_already_exists: false }],
      error: null,
    });
    const { reconcileVerifiedPaymentAction } = await import("./actions");

    await reconcileVerifiedPaymentAction({ paymentReceiptId: "receipt-1", idempotencyKey: "key-6" });

    expect(rpcMock).toHaveBeenCalledWith("reconcile_verified_payment", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_payment_receipt_id: "receipt-1",
      p_method: "manual",
      p_idempotency_key: "key-6",
    });
  });

  it("correctPaymentReconciliationAction memanggil correct_payment_reconciliation dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.reconcile"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_reconciliation_id: "recon-2", out_classification: "unmatched", out_previous_reconciliation_id: "recon-1" }],
      error: null,
    });
    const { correctPaymentReconciliationAction } = await import("./actions");

    await correctPaymentReconciliationAction({
      reconciliationId: "recon-1",
      paymentReceiptId: "receipt-1",
      reason: "Re-check rutin",
      idempotencyKey: "key-7",
    });

    expect(rpcMock).toHaveBeenCalledWith("correct_payment_reconciliation", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_reconciliation_id: "recon-1",
      p_reason: "Re-check rutin",
      p_idempotency_key: "key-7",
    });
  });
});

describe("Gate 2I.2 finance actions -- idempotency key diteruskan apa adanya, tidak di-generate ulang (FIN-10-01)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("dua panggilan recordVerifiedPaymentAction dengan idempotencyKey yang sama mengirim p_idempotency_key yang identik ke RPC", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.record"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_payment_receipt_id: "receipt-1", out_already_exists: false, out_allocations: [] }],
      error: null,
    });
    const { recordVerifiedPaymentAction } = await import("./actions");

    const payload = {
      method: "cash" as const,
      amount: 5000,
      proofs: [{ proofType: "cash_receipt", objectReference: "ref-1" }],
      allocations: [{ invoiceId: "inv-1", amount: 5000 }],
      idempotencyKey: "retry-same-key",
    };

    await recordVerifiedPaymentAction(payload);
    await recordVerifiedPaymentAction(payload);

    expect(rpcMock).toHaveBeenCalledTimes(2);
    const firstKey = rpcMock.mock.calls[0][1].p_idempotency_key;
    const secondKey = rpcMock.mock.calls[1][1].p_idempotency_key;
    expect(firstKey).toBe("retry-same-key");
    expect(secondKey).toBe("retry-same-key");
  });
});

describe("Gate 2I.2 finance actions -- error RPC dipetakan ke pesan Indonesia, kode mentah tidak bocor (FIN-10-03/FIN-11-01/FIN-12-03)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("FIN-11-01: ALLOCATION_EXCEEDS_OUTSTANDING (race condition) dipetakan ke pesan 'muat ulang', kode mentah tidak muncul di pesan", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.record"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "ALLOCATION_EXCEEDS_OUTSTANDING: melebihi 500000" } });
    const { recordVerifiedPaymentAction } = await import("./actions");

    await expect(
      recordVerifiedPaymentAction({
        method: "cash",
        amount: 500000,
        proofs: [{ proofType: "cash_receipt", objectReference: "ref" }],
        allocations: [{ invoiceId: "inv-1", amount: 500000 }],
      })
    ).rejects.toThrow(/muat ulang/i);

    try {
      await recordVerifiedPaymentAction({
        method: "cash",
        amount: 500000,
        proofs: [{ proofType: "cash_receipt", objectReference: "ref" }],
        allocations: [{ invoiceId: "inv-1", amount: 500000 }],
      });
    } catch (err) {
      expect((err as Error).message).not.toContain("ALLOCATION_EXCEEDS_OUTSTANDING");
    }
  });

  it("FIN-10-03: IDEMPOTENCY_KEY_PAYMENT_MISMATCH pada reconcile dipetakan ke pesan Indonesia", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.reconcile"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "IDEMPOTENCY_KEY_PAYMENT_MISMATCH: key dipakai payment lain" } });
    const { reconcileVerifiedPaymentAction } = await import("./actions");

    await expect(reconcileVerifiedPaymentAction({ paymentReceiptId: "receipt-1", idempotencyKey: "reused-key" })).rejects.toThrow(
      /muat ulang/i
    );
  });

  it("FIN-12-03: ALLOCATION_TOTAL_MISMATCH dipetakan ke pesan inline manusiawi", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.record"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "ALLOCATION_TOTAL_MISMATCH: total tidak sama" } });
    const { recordVerifiedPaymentAction } = await import("./actions");

    await expect(
      recordVerifiedPaymentAction({
        method: "cash",
        amount: 1000,
        proofs: [{ proofType: "cash_receipt", objectReference: "ref" }],
        allocations: [{ invoiceId: "inv-1", amount: 900 }],
      })
    ).rejects.toThrow("Total alokasi harus sama dengan nominal pembayaran.");
  });
});

describe("Gate 2I.2 finance actions -- out_already_exists diteruskan apa adanya untuk UI idempotent no-op (FIN-09-04/FIN-10-04)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("FIN-09-04: markPromiseBrokenAction memanggil kedua kalinya mengembalikan out_already_exists=true tanpa error", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.promise"] }));
    rpcMock.mockResolvedValue({ data: [{ out_status: "broken", out_already_exists: true }], error: null });
    const { markPromiseBrokenAction } = await import("./actions");

    const result = await markPromiseBrokenAction({ promiseId: "p-1" });
    expect(result.out_status).toBe("broken");
    expect(result.out_already_exists).toBe(true);
  });

  it("FIN-10-04: cancelPromiseToPayAction pada promise yang sudah cancelled tidak melempar error selama RPC tidak error (idempotent by RPC)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["collection.promise"] }));
    rpcMock.mockResolvedValue({ data: [], error: null });
    const { cancelPromiseToPayAction } = await import("./actions");

    await expect(cancelPromiseToPayAction({ promiseId: "p-1", reason: "Sudah dibatalkan sebelumnya" })).resolves.toBeUndefined();
  });
});

describe("Gate 2I.3 finance actions -- permission guard menolak sebelum RPC dipanggil (FIN-02-05/FIN-02-07/FIN-08-02/FIN-08-03)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestReturnAction menolak actor tanpa return.request", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { requestReturnAction } = await import("./actions");
    await expect(
      requestReturnAction({
        invoiceId: "inv-1",
        items: [{ invoiceLineId: "line-1", requestedQuantity: 2 }],
        reasonCode: "DAMAGED_GOODS",
        proofReference: "storage://proof.jpg",
      })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("verifyReturnAction menolak actor Finance tanpa return.verify (FIN-02-05: Finance punya akses lihat, bukan akses verifikasi)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["receivable.view", "return.request"] }));
    const { verifyReturnAction } = await import("./actions");
    await expect(verifyReturnAction({ returnId: "ret-1", decision: "approve" })).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("requestRefundAction menolak actor tanpa refund.request", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: [] }));
    const { requestRefundAction } = await import("./actions");
    await expect(
      requestRefundAction({
        creditNoteId: "cn-1",
        amount: 1000,
        method: "cash",
        proofReference: "storage://proof.jpg",
        transactionDate: "2026-01-15",
      })
    ).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("approveRefundAction menolak actor Finance tanpa refund.approve (FIN-02-07: Finance punya akses lihat, bukan akses approve)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["receivable.view", "refund.request"] }));
    const { approveRefundAction } = await import("./actions");
    await expect(approveRefundAction({ refundId: "refund-1", decision: "approve" })).rejects.toThrow(/tidak punya akses/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("Gate 2I.3 finance actions -- RPC canonical dipanggil dengan nama & parameter persis migration", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestReturnAction memanggil request_return_atomic dengan parameter & bentuk items persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["return.request"] }));
    rpcMock.mockResolvedValue({ data: [{ out_return_id: "ret-1", out_status: "requested", out_already_exists: false }], error: null });
    const { requestReturnAction } = await import("./actions");

    await requestReturnAction({
      invoiceId: "inv-1",
      items: [{ invoiceLineId: "line-1", requestedQuantity: 3 }],
      reasonCode: "DAMAGED_GOODS",
      proofReference: "storage://return-proofs/x.jpg",
      idempotencyKey: "key-return-1",
    });

    expect(rpcMock).toHaveBeenCalledWith("request_return_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_invoice_id: "inv-1",
      p_items: [{ invoice_line_id: "line-1", requested_quantity: 3 }],
      p_reason_code: "DAMAGED_GOODS",
      p_proof_reference: "storage://return-proofs/x.jpg",
      p_idempotency_key: "key-return-1",
    });
  });

  it("verifyReturnAction memanggil verify_return_atomic dengan parameter persis (tanpa idempotency key -- RPC tidak menerimanya)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["return.verify"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_return_id: "ret-1", out_status: "approved", out_credit_note_id: "cn-1", out_total_amount: "3000", out_applied_amount: "3000", out_customer_credit_amount: "0" }],
      error: null,
    });
    const { verifyReturnAction } = await import("./actions");

    await verifyReturnAction({ returnId: "ret-1", decision: "approve" });

    expect(rpcMock).toHaveBeenCalledWith("verify_return_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_return_id: "ret-1",
      p_decision: "approve",
    });
  });

  it("requestRefundAction memanggil request_refund_atomic dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.request"] }));
    rpcMock.mockResolvedValue({ data: [{ out_refund_id: "refund-1", out_status: "requested", out_already_exists: false }], error: null });
    const { requestRefundAction } = await import("./actions");

    await requestRefundAction({
      creditNoteId: "cn-1",
      amount: 1500,
      method: "bank_transfer",
      proofReference: "storage://refund-proofs/x.jpg",
      transactionDate: "2026-01-15",
      idempotencyKey: "key-refund-1",
    });

    expect(rpcMock).toHaveBeenCalledWith("request_refund_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_credit_note_id: "cn-1",
      p_amount: 1500,
      p_method: "bank_transfer",
      p_proof_reference: "storage://refund-proofs/x.jpg",
      p_transaction_date: "2026-01-15",
      p_idempotency_key: "key-refund-1",
    });
  });

  it("approveRefundAction memanggil approve_refund_atomic dengan parameter persis", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.approve"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_refund_id: "refund-1", out_status: "approved", out_ledger_entry_id: "ledger-1", out_amount: "1500", out_already_exists: false }],
      error: null,
    });
    const { approveRefundAction } = await import("./actions");

    await approveRefundAction({ refundId: "refund-1", decision: "approve" });

    expect(rpcMock).toHaveBeenCalledWith("approve_refund_atomic", {
      p_company_id: "company-1",
      p_actor_id: "actor-1",
      p_refund_id: "refund-1",
      p_decision: "approve",
    });
  });
});

describe("Gate 2I.3 finance actions -- error RPC dipetakan ke pesan Indonesia, kode mentah tidak bocor", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("verifyReturnAction: RETURN_ALREADY_RESOLVED dipetakan ke pesan 'muat ulang', kode mentah tidak bocor (FIN-09-01)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["return.verify"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "RETURN_ALREADY_RESOLVED: return sudah approved" } });
    const { verifyReturnAction } = await import("./actions");

    await expect(verifyReturnAction({ returnId: "ret-1", decision: "reject" })).rejects.toThrow(/muat ulang/i);
    try {
      await verifyReturnAction({ returnId: "ret-1", decision: "reject" });
    } catch (err) {
      expect((err as Error).message).not.toContain("RETURN_ALREADY_RESOLVED");
    }
  });

  it("requestRefundAction: REFUND_EXCEEDS_AVAILABLE_BALANCE dipetakan ke pesan 'muat ulang' (FIN-11-02)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.request"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "REFUND_EXCEEDS_AVAILABLE_BALANCE: melebihi 500000" } });
    const { requestRefundAction } = await import("./actions");

    await expect(
      requestRefundAction({
        creditNoteId: "cn-1",
        amount: 999999,
        method: "cash",
        proofReference: "storage://x.jpg",
        transactionDate: "2026-01-15",
      })
    ).rejects.toThrow(/muat ulang/i);
  });

  it("approveRefundAction: REFUND_ALREADY_RESOLVED dipetakan ke pesan 'muat ulang' (FIN-09-02)", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.approve"] }));
    rpcMock.mockResolvedValue({ data: null, error: { message: "REFUND_ALREADY_RESOLVED: refund sudah rejected" } });
    const { approveRefundAction } = await import("./actions");

    await expect(approveRefundAction({ refundId: "refund-1", decision: "approve" })).rejects.toThrow(/muat ulang/i);
  });
});

describe("Gate 2I.3 finance actions -- out_already_exists diteruskan apa adanya untuk UI idempotent no-op (FIN-10-02)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("approveRefundAction retry approve->approve mengembalikan out_already_exists=true tanpa error", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.approve"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_refund_id: "refund-1", out_status: "approved", out_ledger_entry_id: "ledger-1", out_amount: "1500", out_already_exists: true }],
      error: null,
    });
    const { approveRefundAction } = await import("./actions");

    const result = await approveRefundAction({ refundId: "refund-1", decision: "approve" });
    expect(result.out_status).toBe("approved");
    expect(result.out_already_exists).toBe(true);
  });
});

describe("Gate 2I.3 finance actions -- revalidatePath dipanggil setelah sukses (§5 pola umum, bukan optimistic update)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("requestReturnAction me-revalidate /dashboard/finance/returns, /dashboard/finance/invoices/[id], dan /dashboard/finance", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["return.request"] }));
    rpcMock.mockResolvedValue({ data: [{ out_return_id: "ret-1", out_status: "requested", out_already_exists: false }], error: null });
    const { requestReturnAction } = await import("./actions");

    await requestReturnAction({
      invoiceId: "inv-1",
      items: [{ invoiceLineId: "line-1", requestedQuantity: 1 }],
      reasonCode: "DAMAGED_GOODS",
      proofReference: "storage://x.jpg",
    });

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/returns");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/invoices/inv-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance");
  });

  it("approveRefundAction me-revalidate /dashboard/finance/credit, /dashboard/finance/credit/[id], dan /dashboard/finance", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["refund.approve"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_refund_id: "refund-1", out_status: "approved", out_ledger_entry_id: "ledger-1", out_amount: "1500", out_already_exists: false }],
      error: null,
    });
    const { approveRefundAction } = await import("./actions");

    await approveRefundAction({ refundId: "refund-1", decision: "approve" });

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/credit");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/credit/refund-1");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance");
  });
});

describe("Gate 2I.2 finance actions -- revalidatePath dipanggil setelah sukses (§5 pola umum, bukan optimistic update)", () => {
  afterEach(() => {
    rpcMock.mockClear();
    getAuthUserMock.mockClear();
    revalidatePathMock.mockClear();
    vi.resetModules();
  });

  it("recordVerifiedPaymentAction me-revalidate /dashboard/finance/payments, /dashboard/finance/invoices, dan /dashboard/finance", async () => {
    getAuthUserMock.mockResolvedValue(fakeUser({ permissions: ["payment.record"] }));
    rpcMock.mockResolvedValue({
      data: [{ out_payment_receipt_id: "receipt-1", out_already_exists: false, out_allocations: [] }],
      error: null,
    });
    const { recordVerifiedPaymentAction } = await import("./actions");

    await recordVerifiedPaymentAction({
      method: "cash",
      amount: 1000,
      proofs: [{ proofType: "cash_receipt", objectReference: "ref" }],
      allocations: [{ invoiceId: "inv-1", amount: 1000 }],
    });

    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/payments");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance/invoices");
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/finance");
  });
});
