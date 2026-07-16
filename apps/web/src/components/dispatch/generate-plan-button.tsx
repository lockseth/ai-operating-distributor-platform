"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDispatchPlanAction } from "@/lib/dispatch/actions";
import { Route, Loader2 } from "lucide-react";

/**
 * Trigger tipis ke createDispatchPlanAction() (server action, sudah ada
 * sejak AI Dispatch Planner MVP) -- TIDAK memanggil planDispatch() dari
 * client. Idempotent: aman diklik ulang pada order yang sudah punya plan
 * (server action akan no-op, tidak menimpa hasil/override yang ada).
 */
export function GeneratePlanButton({ salesOrderId, label = "Buat Rencana" }: { salesOrderId: string; label?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await createDispatchPlanAction(salesOrderId);
      if (!result.ok) {
        setError(result.error ?? "Gagal membuat rencana pengiriman.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={isPending}
        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Route className="h-3.5 w-3.5" />}
        {label}
      </button>
      {error && <p className="text-xs text-red-600 max-w-[200px] text-right">{error}</p>}
    </div>
  );
}
