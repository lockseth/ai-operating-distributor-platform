"use client";

import { useState, useTransition } from "react";
import { Smartphone, Loader2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { checkBablastStatusAction, startBablastPairingAction } from "@/lib/integrations/bablast-actions";

interface BablastPairingCardProps {
  canManage: boolean;
}

type ConnectionState = "unknown" | "connected" | "not_connected";

export function BablastPairingCard({ canManage }: BablastPairingCardProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("unknown");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canManage) return null;

  function handleCheckStatus() {
    setError(null);
    startTransition(async () => {
      const result = await checkBablastStatusAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConnectionState(result.data.connected ? "connected" : "not_connected");
    });
  }

  function handleStartPairing() {
    setError(null);
    startTransition(async () => {
      const result = await startBablastPairingAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPairingCode(result.data.pairingCode);
      setQrCode(result.data.qrCode);
    });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <Smartphone className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-gray-900">Koneksi WhatsApp (Bablast)</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Nomor pengirim laporan WhatsApp otomatis (KPI harian, laporan sore, rencana penagihan).
            </p>
          </div>
        </div>
        {connectionState === "connected" && (
          <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5" /> Terhubung
          </span>
        )}
        {connectionState === "not_connected" && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            <XCircle className="h-3.5 w-3.5" /> Belum Terhubung
          </span>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {(pairingCode || qrCode) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-900">Scan/masukkan kode ini di WhatsApp HP Anda:</p>
          {qrCode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrCode} alt="QR pairing WhatsApp" className="h-40 w-40 rounded border border-blue-200 bg-white" />
          )}
          {pairingCode && (
            <p className="font-mono text-lg font-bold tracking-widest text-blue-900">{pairingCode}</p>
          )}
          <p className="text-xs text-blue-700">
            Buka WhatsApp di HP nomor pengirim → Perangkat Tertaut → Tautkan Perangkat, lalu scan/masukkan kode di atas.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleCheckStatus}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Cek Status Koneksi
        </button>
        <button
          onClick={handleStartPairing}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Smartphone className="h-3.5 w-3.5" />}
          Mulai Pairing
        </button>
      </div>
    </div>
  );
}
