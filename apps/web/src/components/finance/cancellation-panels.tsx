"use client";

// =============================================================================
// Gate 2I.4 -- Cancellation & Invoice Void: form pengajuan (kontrak §C) +
// tombol keputusan Owner-only (kontrak §D). RequestCancellationPanel dipakai
// di halaman detail invoice (kontrak §B.4) -- sales_order_id sudah tetap dari
// invoice yang sedang dibuka, BUKAN picker banyak order. DecideCancellationPanel
// dipakai di halaman detail cancellation (kontrak §B.3) -- approve/reject
// memanggil RPC canonical TANPA update langsung ke order/invoice/ledger dari
// sisi client (§A/§F).
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { requestOrderCancellationAction, approveOrderCancellationAction } from "@/lib/finance/actions";

interface RequestCancellationPanelProps {
  salesOrderId: string;
  invoiceId: string;
  canRequest: boolean;
  /** Alasan UX (bukan authority) dari getOrderCancellationEligibility -- null berarti order eligible untuk diajukan. RPC tetap validasi ulang. */
  eligibleBlockedReason: string | null;
}

export function RequestCancellationPanel({
  salesOrderId,
  invoiceId,
  canRequest,
  eligibleBlockedReason,
}: RequestCancellationPanelProps) {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [reasonCode, setReasonCode] = useState("");

  function openDialog() {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setReasonCode("");
    setOpen(true);
  }

  function closeDialog() {
    if (isPending) return;
    setOpen(false);
  }

  function submit() {
    if (!reasonCode.trim()) {
      setError("Alasan pembatalan wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await requestOrderCancellationAction({
          salesOrderId,
          reasonCode: reasonCode.trim(),
          idempotencyKey,
          invoiceId,
        });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canRequest) {
    return (
      <button
        type="button"
        disabled
        title="Bukan kewenangan Anda"
        aria-describedby="request-cancellation-disabled-reason"
        className="cursor-not-allowed rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-300"
      >
        Ajukan Pembatalan Order
        <span id="request-cancellation-disabled-reason" className="sr-only">
          Bukan kewenangan Anda
        </span>
      </button>
    );
  }

  if (eligibleBlockedReason) {
    return (
      <button
        type="button"
        disabled
        title={eligibleBlockedReason}
        aria-describedby="request-cancellation-blocked-reason"
        className="cursor-not-allowed rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-300"
      >
        Ajukan Pembatalan Order
        <span id="request-cancellation-blocked-reason" className="sr-only">
          {eligibleBlockedReason}
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
      >
        Ajukan Pembatalan Order
      </button>
      <ConfirmDialog
        open={open}
        title="Ajukan Pembatalan Order"
        description="Pengajuan ini akan menunggu keputusan Owner. Order dan invoice tidak berubah sampai disetujui."
        confirmLabel="Ajukan Pembatalan"
        danger
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={closeDialog}
      >
        <label className="block text-left text-xs font-medium text-gray-600">
          Alasan Pembatalan
          <input
            type="text"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            placeholder="mis. permintaan customer"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
          />
        </label>
      </ConfirmDialog>
    </>
  );
}

interface DecideCancellationPanelProps {
  cancellationId: string;
  canDecide: boolean;
}

export function DecideCancellationPanel({ cancellationId, canDecide }: DecideCancellationPanelProps) {
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
        await approveOrderCancellationAction({ cancellationId, decision });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canDecide) {
    return (
      <span
        title="Hanya Owner yang dapat menyetujui atau menolak"
        aria-describedby="decide-cancellation-disabled-reason"
        className="cursor-not-allowed text-xs font-medium text-gray-300"
      >
        Keputusan Pembatalan (Hanya Owner)
        <span id="decide-cancellation-disabled-reason" className="sr-only">
          Hanya Owner yang dapat menyetujui atau menolak
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
          Setujui
        </button>
        <button
          type="button"
          onClick={() => openDialog("reject")}
          className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
        >
          Tolak
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title={decision === "approve" ? "Setujui Pembatalan Order" : "Tolak Pembatalan Order"}
        description={
          decision === "approve"
            ? "Menyetujui pembatalan akan membatalkan order. Bila invoice sudah terbit dan belum tersentuh pembayaran/credit note, invoice void penuh akan diterbitkan otomatis."
            : "Menolak pembatalan tidak mengubah order, invoice, atau ledger sama sekali."
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
