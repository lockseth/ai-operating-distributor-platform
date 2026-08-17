"use server";

// =============================================================================
// Gate 2I.2 -- Finance Operations Workspace server action wrapper (kontrak §3
// GAP G2, dipenuhi domain-by-domain mulai gate ini). Pola identik
// apps/web/src/lib/orders/actions.ts: getAuthUser() (session/tenant
// tepercaya, bukan input browser) + hasPermission() guard sebelum RPC
// dipanggil, admin client HANYA di sini (server action), RPC canonical
// Gate 2C/2D/2E dipanggil apa adanya (tidak ada jalur mutation paralel),
// error RPC di-mapping ke pesan Indonesia -- kode error asli tidak pernah
// bocor ke UI (CLAUDE.md: "Jangan mengekspos logika internal di respons API
// publik"). revalidatePath() dipanggil setelah sukses, tidak ada optimistic
// update (kontrak §5/§10).
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { mapFinanceRpcError } from "@/lib/finance/error-messages";

function requirePermission(permissions: string[], required: string, deniedMessage: string) {
  if (!hasPermission(permissions, required)) {
    throw new Error(deniedMessage);
  }
}

function revalidateFinanceQueue() {
  revalidatePath("/dashboard/finance");
}

// ---------------------------------------------------------------------------
// Collection & Janji Bayar (Gate 2C RPC -- migration 20260828000001).
// ---------------------------------------------------------------------------

export interface RecordCollectionActivityInput {
  invoiceId: string;
  channel: "phone" | "whatsapp" | "telegram" | "visit" | "other";
  activityType: "attempt" | "outcome";
  outcome?: string | null;
  reportedAmount?: number | null;
  note?: string | null;
  idempotencyKey?: string;
}

export async function recordCollectionActivityAction(input: RecordCollectionActivityInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "collection.record", "Tidak punya akses untuk mencatat aktivitas collection");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("record_collection_activity", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_invoice_id: input.invoiceId,
    p_channel: input.channel,
    p_activity_type: input.activityType,
    p_outcome: input.outcome ?? null,
    p_reported_amount: input.reportedAmount ?? null,
    p_note: input.note ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/collection");
  revalidateFinanceQueue();
  return (data as Array<{ out_activity_id: string; out_activity_type: string; out_outcome: string | null; out_already_exists: boolean }>)[0];
}

export interface CreatePromiseToPayInput {
  invoiceId: string;
  promisedAmount: number;
  promisedDate: string;
  channel: "phone" | "whatsapp" | "telegram" | "visit" | "other";
  note?: string | null;
  idempotencyKey?: string;
}

export async function createPromiseToPayAction(input: CreatePromiseToPayInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "collection.promise", "Tidak punya akses untuk membuat janji bayar");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("create_promise_to_pay", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_invoice_id: input.invoiceId,
    p_promised_amount: input.promisedAmount,
    p_promised_date: input.promisedDate,
    p_channel: input.channel,
    p_note: input.note ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/collection");
  revalidatePath("/dashboard/finance/invoices");
  revalidateFinanceQueue();
  return (data as Array<{ out_promise_id: string; out_status: string }>)[0];
}

export interface CorrectPromiseToPayInput {
  promiseId: string;
  newPromisedAmount: number;
  newPromisedDate: string;
  reason: string;
  idempotencyKey?: string;
}

export async function correctPromiseToPayAction(input: CorrectPromiseToPayInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "collection.promise", "Tidak punya akses untuk mengoreksi janji bayar");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("correct_promise_to_pay", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_promise_id: input.promiseId,
    p_new_promised_amount: input.newPromisedAmount,
    p_new_promised_date: input.newPromisedDate,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/collection");
  revalidateFinanceQueue();
  return (data as Array<{ out_new_promise_id: string; out_old_promise_id: string }>)[0];
}

export interface CancelPromiseToPayInput {
  promiseId: string;
  reason: string;
  idempotencyKey?: string;
}

export async function cancelPromiseToPayAction(input: CancelPromiseToPayInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "collection.promise", "Tidak punya akses untuk membatalkan janji bayar");

  const admin = getAdminClient();
  const { error } = await admin.rpc("cancel_promise_to_pay", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_promise_id: input.promiseId,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/collection");
  revalidateFinanceQueue();
}

export interface MarkPromiseBrokenInput {
  promiseId: string;
  idempotencyKey?: string;
}

export async function markPromiseBrokenAction(input: MarkPromiseBrokenInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "collection.promise", "Tidak punya akses untuk menandai wanprestasi");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("mark_promise_broken", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_promise_id: input.promiseId,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/collection");
  revalidateFinanceQueue();
  return (data as Array<{ out_status: string; out_already_exists: boolean }>)[0];
}

// ---------------------------------------------------------------------------
// Pembayaran & Verifikasi (Gate 2D RPC -- migration 20260829000001).
// ---------------------------------------------------------------------------

export interface PaymentProofInput {
  proofType: string;
  objectReference: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface RecordVerifiedPaymentInput {
  method: "cash" | "bank_transfer";
  amount: number;
  proofs: PaymentProofInput[];
  allocations: PaymentAllocationInput[];
  transferReference?: string | null;
  idempotencyKey?: string;
}

export async function recordVerifiedPaymentAction(input: RecordVerifiedPaymentInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.record", "Tidak punya akses untuk mencatat pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("record_verified_payment_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_method: input.method,
    p_amount: input.amount,
    p_proofs: input.proofs.map((p) => ({
      proof_type: p.proofType,
      object_reference: p.objectReference,
      metadata: p.metadata ?? {},
    })),
    p_allocations: input.allocations.map((a) => ({ invoice_id: a.invoiceId, amount: a.amount })),
    p_transfer_reference: input.transferReference ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/payments");
  revalidatePath("/dashboard/finance/invoices");
  revalidateFinanceQueue();
  return (data as Array<{
    out_payment_receipt_id: string;
    out_already_exists: boolean;
    out_allocations: Array<{ invoiceId: string; ledgerId: string; allocationId: string; financialStatus: string }>;
  }>)[0];
}

// ---------------------------------------------------------------------------
// Exception Rekonsiliasi (Gate 2E RPC -- migration 20260830000001).
// ---------------------------------------------------------------------------

export interface ReconcileVerifiedPaymentInput {
  paymentReceiptId: string;
  method?: "manual" | "automatic";
  idempotencyKey?: string;
}

export async function reconcileVerifiedPaymentAction(input: ReconcileVerifiedPaymentInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.reconcile", "Tidak punya akses untuk melakukan rekonsiliasi pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("reconcile_verified_payment", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_payment_receipt_id: input.paymentReceiptId,
    p_method: input.method ?? "manual",
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/payments");
  revalidatePath(`/dashboard/finance/payments/${input.paymentReceiptId}`);
  revalidatePath("/dashboard/finance/reconciliation");
  revalidateFinanceQueue();
  return (data as Array<{
    out_reconciliation_id: string;
    out_classification: string;
    out_total_allocated: string;
    out_unallocated_amount: string;
    out_already_exists: boolean;
  }>)[0];
}

export interface CorrectPaymentReconciliationInput {
  reconciliationId: string;
  paymentReceiptId: string;
  reason: string;
  idempotencyKey?: string;
}

export async function correctPaymentReconciliationAction(input: CorrectPaymentReconciliationInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.reconcile", "Tidak punya akses untuk mengoreksi rekonsiliasi pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("correct_payment_reconciliation", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_reconciliation_id: input.reconciliationId,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/reconciliation");
  revalidatePath("/dashboard/finance/payments");
  revalidatePath(`/dashboard/finance/payments/${input.paymentReceiptId}`);
  revalidateFinanceQueue();
  return (data as Array<{ out_reconciliation_id: string; out_classification: string; out_previous_reconciliation_id: string }>)[0];
}

// ---------------------------------------------------------------------------
// Retur & Credit Note (Gate 2F RPC -- migration 20260831000001). Credit note
// TIDAK PERNAH dibuat manual di sini -- verify_return_atomic adalah satu-
// satunya jalur, dan hanya menerbitkannya sebagai side effect approve.
// ---------------------------------------------------------------------------

export interface RequestReturnItemInput {
  invoiceLineId: string;
  requestedQuantity: number;
}

export interface RequestReturnInput {
  invoiceId: string;
  items: RequestReturnItemInput[];
  reasonCode: string;
  proofReference: string;
  idempotencyKey?: string;
}

export async function requestReturnAction(input: RequestReturnInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "return.request", "Tidak punya akses untuk mengajukan retur");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("request_return_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_invoice_id: input.invoiceId,
    p_items: input.items.map((i) => ({ invoice_line_id: i.invoiceLineId, requested_quantity: i.requestedQuantity })),
    p_reason_code: input.reasonCode,
    p_proof_reference: input.proofReference,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/returns");
  revalidatePath(`/dashboard/finance/invoices/${input.invoiceId}`);
  revalidateFinanceQueue();
  return (data as Array<{ out_return_id: string; out_status: string; out_already_exists: boolean }>)[0];
}

export interface VerifyReturnInput {
  returnId: string;
  decision: "approve" | "reject";
}

export async function verifyReturnAction(input: VerifyReturnInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "return.verify", "Tidak punya akses untuk memverifikasi retur");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("verify_return_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_return_id: input.returnId,
    p_decision: input.decision,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/returns");
  revalidatePath(`/dashboard/finance/returns/${input.returnId}`);
  revalidatePath("/dashboard/finance/credit");
  revalidateFinanceQueue();
  return (data as Array<{
    out_return_id: string;
    out_status: string;
    out_credit_note_id: string | null;
    out_total_amount: string | null;
    out_applied_amount: string | null;
    out_customer_credit_amount: string | null;
  }>)[0];
}

// ---------------------------------------------------------------------------
// Customer Credit & Refund (Gate 2H RPC -- migration 20260902000001). Refund
// TIDAK PERNAH menyentuh receivable_ledger/invoice/order/delivery -- hanya
// customer_credit_ledger + refund_requests (kontrak §5.6/§8).
// ---------------------------------------------------------------------------

export interface RequestRefundInput {
  creditNoteId: string;
  amount: number;
  method: "cash" | "bank_transfer";
  proofReference: string;
  transactionDate: string;
  idempotencyKey?: string;
}

export async function requestRefundAction(input: RequestRefundInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "refund.request", "Tidak punya akses untuk mengajukan refund");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("request_refund_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_credit_note_id: input.creditNoteId,
    p_amount: input.amount,
    p_method: input.method,
    p_proof_reference: input.proofReference,
    p_transaction_date: input.transactionDate,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/credit");
  revalidateFinanceQueue();
  return (data as Array<{ out_refund_id: string; out_status: string; out_already_exists: boolean }>)[0];
}

export interface ApproveRefundInput {
  refundId: string;
  decision: "approve" | "reject";
}

export async function approveRefundAction(input: ApproveRefundInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "refund.approve", "Tidak punya akses untuk memutuskan refund");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("approve_refund_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_refund_id: input.refundId,
    p_decision: input.decision,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/credit");
  revalidatePath(`/dashboard/finance/credit/${input.refundId}`);
  revalidateFinanceQueue();
  return (data as Array<{
    out_refund_id: string;
    out_status: string;
    out_ledger_entry_id: string | null;
    out_amount: string | null;
    out_already_exists: boolean;
  }>)[0];
}

// ---------------------------------------------------------------------------
// Order Cancellation & Invoice Void (Gate 2G RPC -- migration 20260901000001).
// request_order_cancellation_atomic TIDAK PERNAH menyentuh sales_orders.status/
// invoices/receivable_ledger -- efek finansial hanya lewat approve. Approve
// permission order_cancellation.approve HANYA owner (migration §5) -- guard
// di sini adalah defense kedua, force-enable DOM tetap ditolak sebelum RPC
// (FIN-02-09).
// ---------------------------------------------------------------------------

export interface RequestOrderCancellationInput {
  salesOrderId: string;
  reasonCode: string;
  idempotencyKey?: string;
  /** Opsional -- hanya dipakai untuk revalidatePath saat panel dipanggil dari halaman detail invoice (kontrak §B.4); RPC tidak menerima/butuh invoiceId. */
  invoiceId?: string;
}

export async function requestOrderCancellationAction(input: RequestOrderCancellationInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "order_cancellation.request", "Tidak punya akses untuk mengajukan pembatalan order");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("request_order_cancellation_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_sales_order_id: input.salesOrderId,
    p_reason_code: input.reasonCode,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/cancellations");
  if (input.invoiceId) revalidatePath(`/dashboard/finance/invoices/${input.invoiceId}`);
  revalidateFinanceQueue();
  return (data as Array<{ out_cancellation_id: string; out_status: string; out_already_exists: boolean }>)[0];
}

export interface ApproveOrderCancellationInput {
  cancellationId: string;
  decision: "approve" | "reject";
}

export async function approveOrderCancellationAction(input: ApproveOrderCancellationInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "order_cancellation.approve", "Tidak punya akses untuk memutuskan pembatalan order");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("approve_order_cancellation_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_cancellation_id: input.cancellationId,
    p_decision: input.decision,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/cancellations");
  revalidatePath(`/dashboard/finance/cancellations/${input.cancellationId}`);
  revalidatePath("/dashboard/finance/invoices");
  revalidateFinanceQueue();
  return (data as Array<{
    out_cancellation_id: string;
    out_status: string;
    out_order_status: string | null;
    out_invoice_void_id: string | null;
    out_voided_amount: string | null;
  }>)[0];
}

// ---------------------------------------------------------------------------
// Klaim Pembayaran sales/driver "all-in" + review Owner/Finance (Gate P4.06
// RPC -- migration 20261010000001). Klaim TIDAK PERNAH menyentuh
// receivable_ledger secara langsung -- hanya approvePaymentClaimAction
// (delegasi ke record_verified_payment_atomic yang sudah locked) yang bisa.
// rejectPaymentClaimAction murni ubah status, ledger tidak tersentuh.
// ---------------------------------------------------------------------------

export interface SubmitPaymentClaimInput {
  customerId: string;
  method: "cash" | "bank_transfer";
  amount: number;
  transferReference?: string | null;
  note?: string | null;
  proofs?: PaymentProofInput[];
  idempotencyKey?: string;
}

export async function submitPaymentClaimAction(input: SubmitPaymentClaimInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.claim", "Tidak punya akses untuk melaporkan pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("submit_payment_claim_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_customer_id: input.customerId,
    p_method: input.method,
    p_amount: input.amount,
    p_transfer_reference: input.transferReference ?? null,
    p_note: input.note ?? null,
    p_proofs: (input.proofs ?? []).map((p) => ({
      proof_type: p.proofType,
      object_reference: p.objectReference,
      metadata: p.metadata ?? {},
    })),
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/payment-claims");
  revalidatePath("/dashboard/finance/payment-claims");
  return (data as Array<{ out_claim_id: string; out_already_exists: boolean; out_status: string }>)[0];
}

export interface ApprovePaymentClaimInput {
  claimId: string;
  proofs: PaymentProofInput[];
  allocations: PaymentAllocationInput[];
}

export async function approvePaymentClaimAction(input: ApprovePaymentClaimInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.record", "Tidak punya akses untuk menyetujui klaim pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("approve_payment_claim_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_claim_id: input.claimId,
    p_proofs: input.proofs.map((p) => ({
      proof_type: p.proofType,
      object_reference: p.objectReference,
      metadata: p.metadata ?? {},
    })),
    p_allocations: input.allocations.map((a) => ({ invoice_id: a.invoiceId, amount: a.amount })),
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/payment-claims");
  revalidatePath("/dashboard/finance/payments");
  revalidatePath("/dashboard/finance/invoices");
  revalidateFinanceQueue();
  return (data as Array<{ out_outcome: string; out_payment_receipt_id: string | null }>)[0];
}

export interface RejectPaymentClaimInput {
  claimId: string;
  rejectionReason: string;
}

export async function rejectPaymentClaimAction(input: RejectPaymentClaimInput) {
  const user = await getAuthUser();
  requirePermission(user.permissions, "payment.record", "Tidak punya akses untuk menolak klaim pembayaran");

  const admin = getAdminClient();
  const { data, error } = await admin.rpc("reject_payment_claim_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_claim_id: input.claimId,
    p_rejection_reason: input.rejectionReason,
  });
  if (error) throw new Error(mapFinanceRpcError(error.message));

  revalidatePath("/dashboard/finance/payment-claims");
  revalidateFinanceQueue();
  return (data as Array<{ out_outcome: string }>)[0];
}
