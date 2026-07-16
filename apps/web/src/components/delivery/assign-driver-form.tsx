"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDeliveryAction } from "@/lib/delivery/actions";
import { Truck, Loader2 } from "lucide-react";

interface DriverOption {
  id: string;
  full_name: string;
}

interface AssignDriverFormProps {
  salesOrderId: string;
  drivers: DriverOption[];
}

export function AssignDriverForm({ salesOrderId, drivers }: AssignDriverFormProps) {
  const router = useRouter();
  const [driverId, setDriverId] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (drivers.length === 0) {
    return (
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Truck className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Delivery Verification</h2>
        </div>
        <p className="text-xs text-gray-500">
          Belum ada driver terdaftar di Telegram untuk tenant ini. Daftarkan driver ke
          <code className="mx-1 rounded bg-gray-100 px-1 py-0.5">telegram_identities</code>
          terlebih dahulu (lihat dokumentasi Telegram Sales Order Entry).
        </p>
      </div>
    );
  }

  function handleSubmit() {
    if (!driverId) {
      setError("Pilih driver terlebih dahulu.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createDeliveryAction(salesOrderId, driverId);
      if (!result.ok) {
        setError(result.error ?? "Gagal membuat delivery.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Truck className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">Delivery Verification</h2>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Order sudah confirmed. Assign driver untuk mengirim tugas pengiriman via Telegram.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
          disabled={isPending}
        >
          <option value="">Pilih driver…</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.full_name}
            </option>
          ))}
        </select>
        <button
          onClick={handleSubmit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Truck className="h-3.5 w-3.5" />}
          Assign &amp; Kirim Tugas
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
