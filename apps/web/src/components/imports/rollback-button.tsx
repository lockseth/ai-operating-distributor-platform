"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Undo2, Loader2 } from "lucide-react";
import { rollbackImportBatchAction } from "@/lib/imports/actions";

export function RollbackButton({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<{ rowNumber: number; entityTable: string; reason: string }[] | null>(null);

  function submit() {
    if (!reason.trim()) { setError("Alasan rollback wajib diisi."); return; }
    setError(null);
    setBlockers(null);
    startTransition(async () => {
      const result = await rollbackImportBatchAction({ batchId, reason: reason.trim() });
      if (!result.ok) {
        setError(result.error ?? "Rollback gagal.");
        if (result.data?.blockers) setBlockers(result.data.blockers);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
        <Undo2 className="h-3.5 w-3.5" /> Rollback
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 500))}
        disabled={isPending}
        placeholder="Alasan rollback (wajib)"
        rows={2}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
      />
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={isPending} className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-60">
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Konfirmasi Rollback
        </button>
        <button onClick={() => setOpen(false)} disabled={isPending} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
          Batal
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {blockers && blockers.length > 0 && (
        <div className="rounded-lg bg-white p-2 space-y-1">
          <p className="text-xs font-medium text-red-700">Blocker:</p>
          {blockers.map((b, i) => (
            <p key={i} className="text-xs text-gray-600">Baris {b.rowNumber} ({b.entityTable}): {b.reason}</p>
          ))}
        </div>
      )}
    </div>
  );
}
