"use client";

// Tombol "Terbitkan Invoice" di detail order (status Terkirim, belum punya
// invoice). Memanggil issueInvoiceAction -> issue_invoice_atomic; setelah
// sukses pindah ke halaman invoice yang baru terbit.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { issueInvoiceAction } from "@/lib/finance/actions";

export function IssueInvoiceButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await issueInvoiceAction(orderId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      router.push(`/dashboard/finance/invoices/${result.invoiceId}`);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
      >
        Terbitkan Invoice
      </button>
      <ConfirmDialog
        open={open}
        title="Terbitkan Invoice"
        description="Invoice dibuat dari jumlah barang yang benar-benar diterima pelanggan dan tidak bisa diubah setelah terbit. Lanjutkan?"
        confirmLabel="Terbitkan Sekarang"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={() => !isPending && setOpen(false)}
      />
    </>
  );
}
