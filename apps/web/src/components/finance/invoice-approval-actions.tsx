"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideInvoiceApprovalAction } from "@/lib/finance/actions";

export function InvoiceApprovalActions({ approvalId }: { approvalId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function decide(decision: "approved" | "rejected") {
    setError(null);
    startTransition(async () => {
      const res = await decideInvoiceApprovalAction(approvalId, decision, note);
      if (!res.ok) { setError(res.error ?? "Gagal."); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <input
        value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (wajib bila menolak)"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      <div className="flex gap-2">
        <button type="button" disabled={isPending} onClick={() => decide("approved")} className="rounded-lg bg-green-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60">Setujui</button>
        <button type="button" disabled={isPending} onClick={() => decide("rejected")} className="rounded-lg border border-red-300 px-3.5 py-2 text-sm font-semibold text-red-700 disabled:opacity-60">Tolak</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
