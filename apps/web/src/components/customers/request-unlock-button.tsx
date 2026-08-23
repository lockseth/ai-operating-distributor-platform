"use client";

// =============================================================================
// Gate P4.16 -- Tombol "Ajukan Buka Kunci" di halaman detail pelanggan.
// Hanya dirender server-side untuk role sales pada toko yang SEDANG terkunci
// (is_customer_order_locked() TRUE) -- lihat customers/[id]/page.tsx.
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { submitStoreUnlockRequestAction } from "@/lib/customers/unlock-request-actions";
import { Lock } from "lucide-react";

interface RequestUnlockButtonProps {
  customerId: string;
  customerName: string;
  hasPendingRequest: boolean;
}

export function RequestUnlockButton({ customerId, customerName, hasPendingRequest }: RequestUnlockButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(hasPendingRequest);
  const [isPending, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  function close() {
    if (isPending) return;
    setOpen(false);
  }

  function submit() {
    if (reason.trim().length < 3) {
      setError("Alasan pengajuan wajib diisi (minimal 3 karakter).");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await submitStoreUnlockRequestAction({ customerId, reason: reason.trim(), idempotencyKey });
        setDone(true);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (done) {
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">
        <Lock className="h-3.5 w-3.5" />
        Menunggu keputusan Owner
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
      >
        <Lock className="h-3.5 w-3.5" />
        Ajukan Buka Kunci
      </button>

      <ConfirmDialog
        open={open}
        title="Ajukan Buka Kunci Toko"
        confirmLabel="Ajukan"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={close}
      >
        <div className="space-y-2 text-left text-xs">
          <p className="text-gray-500">
            Toko <span className="font-medium text-gray-700">{customerName}</span> terkunci karena ada tagihan
            tertunggak lebih dari 3 hari. Pengajuan ini akan dikirim ke Owner untuk disetujui.
          </p>
          <label className="block font-medium text-gray-600">
            Alasan
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}
