"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { commitImportBatchAction } from "@/lib/imports/actions";

export function CommitButton({ batchId, isRetry }: { batchId: string; isRetry?: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [needsAck, setNeedsAck] = useState(false);

  function submit(acknowledgeDuplicateFile = false) {
    setError(null);
    startTransition(async () => {
      const result = await commitImportBatchAction({ batchId, acknowledgeDuplicateFile });
      if (!result.ok) {
        if (result.error?.includes("sudah pernah di-commit")) { setNeedsAck(true); setError(result.error); return; }
        setError(result.error ?? "Commit gagal.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <button
        onClick={() => submit(false)}
        disabled={isPending}
        className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        {isRetry ? "Coba Commit Lagi" : "Commit Import"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {needsAck && (
        <button onClick={() => submit(true)} disabled={isPending} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50">
          Tetap Commit (Saya Sengaja)
        </button>
      )}
    </div>
  );
}
