"use client";

// =============================================================================
// Gate 2I.3 -- Customer Credit & Refund: form pengajuan (kontrak §5.6) +
// tombol keputusan Owner-only. RequestRefundPanel dirender PER credit note
// (baris pada halaman list) -- credit_note_id sudah tetap dari konteks baris,
// bukan dropdown yang bisa mengagregasi saldo lintas credit note (kontrak §8
// "larangan tegas": tidak boleh ada FIFO/penggabungan beberapa credit note).
// ApproveRefundPanel dipakai di halaman detail refund.
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { requestRefundAction, approveRefundAction } from "@/lib/finance/actions";

interface RequestRefundPanelProps {
  creditNoteId: string;
  customerCreditAmount: number;
  isInitialized: boolean;
  availableBalance: number;
  canRequest: boolean;
}

export function RequestRefundPanel({
  creditNoteId,
  customerCreditAmount,
  isInitialized,
  availableBalance,
  canRequest,
}: RequestRefundPanelProps) {
  // Selama saldo BELUM diinisialisasi (customer_credit_ledger belum punya baris
  // credit_note_origin untuk credit note ini), availableBalance dari view SELALU
  // 0 by design (COALESCE pada customer_credit_balances -- lihat komentar
  // CreditNoteListItem.isInitialized di queries.ts) -- itu BUKAN saldo habis.
  // effectiveMax dipakai HANYA sebagai batas input pra-submit (bantuan UX,
  // bukan validasi final) -- RPC request_refund_atomic tetap sumber kebenaran
  // dan yang benar-benar menginisialisasi + memvalidasi saldo di dalam lock.
  const effectiveMax = isInitialized ? availableBalance : customerCreditAmount;
  const isExhausted = isInitialized && availableBalance <= 0;
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [proofReference, setProofReference] = useState("");
  const [transactionDate, setTransactionDate] = useState("");

  function openDialog() {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setAmount("");
    setMethod("cash");
    setProofReference("");
    setTransactionDate("");
    setOpen(true);
  }

  function closeDialog() {
    if (isPending) return;
    setOpen(false);
  }

  function submit() {
    const amountNumber = Number(amount) || 0;
    if (amountNumber <= 0) {
      setError("Nominal refund harus lebih besar dari nol.");
      return;
    }
    if (amountNumber > effectiveMax) {
      setError("Nominal refund melebihi saldo tersedia pada credit note ini.");
      return;
    }
    if (!proofReference.trim()) {
      setError("Referensi bukti refund wajib diisi.");
      return;
    }
    if (!transactionDate) {
      setError("Tanggal transaksi wajib diisi.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await requestRefundAction({
          creditNoteId,
          amount: amountNumber,
          method,
          proofReference: proofReference.trim(),
          transactionDate,
          idempotencyKey,
        });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (isExhausted) {
    return <span className="text-xs text-gray-400">Saldo tersedia habis</span>;
  }

  if (!canRequest) {
    return (
      <button
        type="button"
        disabled
        title="Bukan kewenangan Anda"
        aria-describedby="request-refund-disabled-reason"
        className="cursor-not-allowed rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-300"
      >
        Ajukan Refund
        <span id="request-refund-disabled-reason" className="sr-only">
          Bukan kewenangan Anda
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
      >
        Ajukan Refund
      </button>
      <ConfirmDialog
        open={open}
        title="Ajukan Refund"
        description={
          isInitialized
            ? `Saldo tersedia pada credit note ini: ${formatRupiah(availableBalance)}. Refund hanya mengacu pada satu credit note ini, tidak digabung dengan credit note lain.`
            : `Saldo belum diinisialisasi -- nilai credit awal: ${formatRupiah(customerCreditAmount)}. Permintaan pertama akan menginisialisasi saldo customer credit ini. Refund hanya mengacu pada satu credit note ini, tidak digabung dengan credit note lain.`
        }
        confirmLabel="Ajukan Refund"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={closeDialog}
      >
        <div className="space-y-3 text-left">
          {!isInitialized && (
            <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs text-amber-700">
              Saldo customer credit ini belum diinisialisasi. Nilai credit awal (
              {formatRupiah(customerCreditAmount)}) dipakai sebagai batas nominal sementara -- nilai final tetap ditentukan server saat submit.
            </p>
          )}
          <label className="block text-xs font-medium text-gray-600">
            Nominal Refund
            <input
              type="number"
              min={1}
              max={effectiveMax}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Metode
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "cash" | "bank_transfer")}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              <option value="cash">Tunai</option>
              <option value="bank_transfer">Transfer Bank</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Referensi Bukti
            <input
              type="text"
              value={proofReference}
              onChange={(e) => setProofReference(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Tanggal Transaksi
            <input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}

interface ApproveRefundPanelProps {
  refundId: string;
  canApprove: boolean;
}

export function ApproveRefundPanel({ refundId, canApprove }: ApproveRefundPanelProps) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openDialog(next: "approve" | "reject") {
    setError(null);
    setDecision(next);
    setOpen(true);
  }

  function submit() {
    if (!decision) return;
    setError(null);
    startTransition(async () => {
      try {
        await approveRefundAction({ refundId, decision });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canApprove) {
    return (
      <span
        title="Hanya Owner yang dapat menyetujui"
        aria-describedby="approve-refund-disabled-reason"
        className="cursor-not-allowed text-xs font-medium text-gray-300"
      >
        Approve/Reject Refund (Hanya Owner)
        <span id="approve-refund-disabled-reason" className="sr-only">
          Hanya Owner yang dapat menyetujui
        </span>
      </span>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => openDialog("approve")}
          className="rounded-lg bg-green-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-green-700"
        >
          Setujui Refund
        </button>
        <button
          type="button"
          onClick={() => openDialog("reject")}
          className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
        >
          Tolak Refund
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title={decision === "approve" ? "Setujui Refund" : "Tolak Refund"}
        description={
          decision === "approve"
            ? "Menyetujui refund akan mencatat pengurangan saldo customer credit. Refund tidak menyentuh piutang, invoice, order, atau delivery."
            : "Menolak refund melepaskan reservasi saldo tanpa efek ledger apa pun."
        }
        confirmLabel={decision === "approve" ? "Setujui" : "Tolak"}
        danger={decision === "reject"}
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={() => !isPending && setOpen(false)}
      />
    </>
  );
}
