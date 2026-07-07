"use client";

import { useState, useTransition } from "react";
import { cancelOrderAction } from "@/lib/orders/actions";
import { XCircle, Loader2 } from "lucide-react";

export function CancelButton({ orderId }: { orderId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      try {
        await cancelOrderAction(orderId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
        setShowConfirm(false);
      }
    });
  }

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600">Batalkan order ini?</span>
        <button onClick={() => setShowConfirm(false)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
          Tidak
        </button>
        <button onClick={handleCancel} disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60">
          {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Ya, Batalkan
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button onClick={() => setShowConfirm(true)} disabled={isPending}
        className="flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60">
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
        Batalkan Order
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
