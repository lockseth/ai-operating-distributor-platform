"use client";

// Tombol langkah pengantar (S1): Mulai Antar -> Sudah Tiba. Lokasi diminta
// dari browser saat tiba; bila ditolak/gagal pengantar boleh lanjut dan
// pengiriman ditandai "tanpa lokasi" (keputusan Founder 2026-10-30).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { arriveDeliveryAction, startDeliveryAction } from "@/lib/delivery/web-actions";
import type { GeoFix } from "@/lib/delivery/web-rules";
import type { DeliveryNextStep } from "@/lib/delivery/web-rules";

function getPosition(): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}

export function DeliveryTaskActions({ deliveryId, step }: { deliveryId: string; step: DeliveryNextStep }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [needLocationConfirm, setNeedLocationConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Terjadi kesalahan.");
        return;
      }
      setNeedLocationConfirm(false);
      router.refresh();
    });
  }

  function arrive(allowWithoutLocation: boolean) {
    setError(null);
    startTransition(async () => {
      const fix = await getPosition();
      if (!fix && !allowWithoutLocation) {
        setNeedLocationConfirm(true);
        return;
      }
      const result = await arriveDeliveryAction(deliveryId, fix);
      if (!result.ok) {
        setError(result.error ?? "Terjadi kesalahan.");
        return;
      }
      setNeedLocationConfirm(false);
      router.refresh();
    });
  }

  if (step === "done") return null;

  return (
    <div className="space-y-3">
      {step === "start" && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => startDeliveryAction(deliveryId))}
          className="w-full rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
        >
          {isPending ? "Memproses..." : "Mulai Antar"}
        </button>
      )}
      {step === "arrive" && (
        <>
          <button
            type="button"
            disabled={isPending}
            onClick={() => arrive(false)}
            className="w-full rounded-xl bg-blue-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
          >
            {isPending ? "Memproses..." : "Sudah Tiba di Toko"}
          </button>
          {needLocationConfirm && (
            <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p>Lokasi tidak bisa dibaca. Pengiriman akan ditandai &quot;tanpa lokasi&quot; dan bisa diperiksa Owner.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={isPending} onClick={() => arrive(true)} className="rounded-lg bg-amber-600 px-3 py-2 font-semibold text-white">
                  Lanjut tanpa lokasi
                </button>
                <button type="button" disabled={isPending} onClick={() => arrive(false)} className="rounded-lg border border-amber-300 px-3 py-2 font-semibold">
                  Coba lagi
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
