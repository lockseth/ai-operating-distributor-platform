"use client";

import { useState, useTransition } from "react";
import { deactivateCustomerAction, activateCustomerAction } from "@/lib/customers/actions";
import { UserX, UserCheck, Loader2 } from "lucide-react";

interface DeactivateButtonProps {
  customerId: string;
  isActive: boolean;
}

export function DeactivateButton({ customerId, isActive }: DeactivateButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  function handleAction() {
    setError(null);
    startTransition(async () => {
      try {
        if (isActive) {
          await deactivateCustomerAction(customerId);
        } else {
          await activateCustomerAction(customerId);
        }
        setShowConfirm(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
        setShowConfirm(false);
      }
    });
  }

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600">
          {isActive ? "Nonaktifkan pelanggan ini?" : "Aktifkan pelanggan ini?"}
        </span>
        <button onClick={() => setShowConfirm(false)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
          Batal
        </button>
        <button onClick={handleAction} disabled={isPending}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 ${
            isActive ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"
          }`}>
          {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          {isActive ? "Ya, Nonaktifkan" : "Ya, Aktifkan"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => setShowConfirm(true)}
        disabled={isPending}
        className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-60 ${
          isActive
            ? "border-red-200 text-red-600 hover:bg-red-50"
            : "border-green-200 text-green-600 hover:bg-green-50"
        }`}
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isActive ? (
          <UserX className="h-4 w-4" />
        ) : (
          <UserCheck className="h-4 w-4" />
        )}
        {isActive ? "Nonaktifkan" : "Aktifkan Kembali"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
