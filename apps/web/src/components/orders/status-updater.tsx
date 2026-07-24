"use client";

import { useState, useTransition } from "react";
import { updateOrderStatusAction } from "@/lib/orders/actions";
import type { OrderStatus } from "@/lib/orders/actions";
import { ChevronRight, Loader2 } from "lucide-react";

// Status paid & invoiced TIDAK ditawarkan sebagai transisi generik -- lihat
// migration 20260824000001 (paid) & 20260825000001 (invoiced). Menandai
// order paid hanya boleh lewat payment workflow terverifikasi; menandai
// invoiced hanya boleh lewat jalur issuance invoice canonical (keduanya
// belum ada di aplikasi ini, gate mendatang) -- bukan klik status generik
// ini, termasuk untuk owner sekalipun.
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft:      ["confirmed", "cancelled"],
  confirmed:  ["processing", "cancelled"],
  processing: ["delivering", "cancelled"],
  delivering: ["delivered"],
  delivered:  [],
  invoiced:   [],
  paid:       [],
  cancelled:  [],
};

// "paid" & "invoiced" tidak pernah muncul sebagai target transisi (lihat
// TRANSITIONS di atas) -- label ini hanya menjaga Record tetap type-complete
// per OrderStatus.
const STATUS_LABELS: Record<OrderStatus, string> = {
  draft:      "Draft",
  confirmed:  "Konfirmasi",
  processing: "Proses",
  delivering: "Kirim",
  delivered:  "Tandai Terkirim",
  invoiced:   "Tagih",
  paid:       "Lunas",
  cancelled:  "Batalkan",
};

interface StatusUpdaterProps {
  orderId: string;
  currentStatus: OrderStatus;
}

export function StatusUpdater({ orderId, currentStatus }: StatusUpdaterProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);

  const nextStatuses = TRANSITIONS[currentStatus] ?? [];

  if (nextStatuses.length === 0) {
    if (currentStatus === "delivered") {
      return (
        <p className="text-xs text-gray-500">
          Penerbitan invoice terverifikasi belum tersedia di modul ini.
        </p>
      );
    }
    if (currentStatus === "invoiced") {
      return (
        <p className="text-xs text-gray-500">
          Pencatatan pembayaran terverifikasi belum tersedia di modul ini.
        </p>
      );
    }
    return null;
  }

  function handleUpdate(status: OrderStatus) {
    setError(null);
    startTransition(async () => {
      try {
        await updateOrderStatusAction(orderId, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Gagal update status");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {nextStatuses.map((status) => (
          <button
            key={status}
            onClick={() => handleUpdate(status)}
            disabled={isPending}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
              status === "cancelled"
                ? "border border-red-200 text-red-600 hover:bg-red-50"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
