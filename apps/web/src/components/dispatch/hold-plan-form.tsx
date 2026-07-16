"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { overrideDispatchPlanAction } from "@/lib/dispatch/actions";
import { PauseCircle, Loader2 } from "lucide-react";

const REASON_MAX_LENGTH = 500;

/**
 * "Override Rekomendasi" -- state machine dispatch_plans TIDAK punya status
 * "rejected"/"ditolak" (hanya document_ready/waiting_planning/planned/
 * scheduled/ready_for_delivery/waiting_stock/customer_requested_delay/
 * manual_hold/route_conflict/cancelled). manual_hold adalah satu-satunya
 * transisi yang sah untuk "manusia menahan/tidak setuju dengan rekomendasi
 * AI" -- tidak menciptakan status baru.
 */
export function HoldPlanForm({ planId }: { planId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (reason.trim().length === 0) {
      setError("Alasan wajib diisi untuk menahan/override rencana ini.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await overrideDispatchPlanAction(planId, { action: "hold", reason: reason.trim() });
      if (!result.ok) {
        setError(result.error ?? "Gagal menahan dispatch plan.");
        return;
      }
      setOpen(false);
      setReason("");
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
      >
        <PauseCircle className="h-3.5 w-3.5" />
        Override Rekomendasi (Tunda)
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
      <p className="text-xs font-medium text-amber-800">Tunda rencana ini — wajib isi alasan:</p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX_LENGTH))}
        disabled={isPending}
        placeholder="Contoh: toko minta ditunda, stok fisik tidak sesuai, dsb."
        rows={2}
        maxLength={REASON_MAX_LENGTH}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Konfirmasi Tunda
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={isPending}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          Batal
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
