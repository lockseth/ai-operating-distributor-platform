"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserCheck, UserX } from "lucide-react";
import { setSalesmanActiveStatusAction } from "@/lib/salesman/actions";

export function SalesmanStatusControl({
  salesmanId,
  isActive,
}: {
  salesmanId: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await setSalesmanActiveStatusAction(salesmanId, !isActive);
      if (!result.ok) {
        setError(result.error ?? "Gagal mengubah status.");
        return;
      }
      setShowConfirm(false);
      router.refresh();
    });
  }

  if (showConfirm) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <span className="text-xs text-gray-600">
          {isActive
            ? "Nonaktifkan Salesman ini? Akses operasional (web & Telegram) akan langsung terhenti."
            : "Aktifkan kembali Salesman ini?"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowConfirm(false)}
            disabled={isPending}
            className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-white disabled:opacity-60 ${
              isActive ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"
            }`}
          >
            {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {isActive ? "Ya, Nonaktifkan" : "Ya, Aktifkan"}
          </button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        disabled={isPending}
        className={`inline-flex items-center gap-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
          isActive ? "text-red-600 hover:text-red-700" : "text-green-600 hover:text-green-700"
        }`}
      >
        {isActive ? <UserX className="h-3 w-3" /> : <UserCheck className="h-3 w-3" />}
        {isActive ? "Nonaktifkan Salesman" : "Aktifkan Salesman"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
