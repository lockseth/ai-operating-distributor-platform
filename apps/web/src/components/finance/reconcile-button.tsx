"use client";

// Gate 2I.2 -- tombol "Rekonsiliasi" (reconcile_verified_payment, kontrak
// §5.4) di halaman detail payment. Hanya tampil untuk payment_receipt yang
// BELUM punya baris payment_reconciliations sama sekali (rekonsiliasi
// PERTAMA) -- koreksi berikutnya dilakukan dari halaman Exception
// Rekonsiliasi (correct_payment_reconciliation, alasan wajib).

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { reconcileVerifiedPaymentAction } from "@/lib/finance/actions";

export function ReconcileButton({ paymentReceiptId, canReconcile }: { paymentReceiptId: string; canReconcile: boolean }) {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openDialog() {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setOpen(true);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        await reconcileVerifiedPaymentAction({ paymentReceiptId, idempotencyKey });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canReconcile) {
    return (
      <span title="Bukan kewenangan Anda" className="cursor-not-allowed text-xs font-medium text-gray-300">
        Rekonsiliasi (Bukan kewenangan Anda)
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
      >
        Rekonsiliasi
      </button>
      <ConfirmDialog
        open={open}
        title="Rekonsiliasi Pembayaran"
        description="Mengklasifikasikan hasil alokasi pembayaran ini terhadap total nominal yang diterima."
        confirmLabel="Rekonsiliasi Sekarang"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={() => !isPending && setOpen(false)}
      />
    </>
  );
}
