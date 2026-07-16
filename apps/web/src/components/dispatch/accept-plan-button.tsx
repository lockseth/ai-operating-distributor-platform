"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptDispatchPlanAction } from "@/lib/dispatch/actions";
import { CheckCircle2, Loader2 } from "lucide-react";

/** "Terima Rekomendasi AI" -- tidak mengubah data, hanya mencatat review. */
export function AcceptPlanButton({ planId }: { planId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await acceptDispatchPlanAction(planId);
      if (!result.ok) {
        setError(result.error ?? "Gagal menerima rekomendasi.");
        return;
      }
      setAccepted(true);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={handleClick}
        disabled={isPending || accepted}
        className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        {accepted ? "Rekomendasi Diterima" : "Terima Rekomendasi AI"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
