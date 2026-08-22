"use client";

import { useEffect, useState, useTransition } from "react";
import { Smartphone, Loader2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import QRCode from "qrcode";
import { checkBablastStatusAction, startBablastPairingAction } from "@/lib/integrations/bablast-actions";

interface BablastPairingCardProps {
  canManage: boolean;
}

type ConnectionState = "unknown" | "connected" | "not_connected";

export function BablastPairingCard({ canManage }: BablastPairingCardProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("unknown");
  const [connectedPhone, setConnectedPhone] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrImageDataUrl, setQrImageDataUrl] = useState<string | null>(null);
  const [alreadyConnectedNote, setAlreadyConnectedNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!qrCode) {
      setQrImageDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrCode, { width: 240, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setQrImageDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setError("Gagal membuat gambar QR dari data pairing.");
      });
    return () => {
      cancelled = true;
    };
  }, [qrCode]);

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
      setConnectedPhone(result.data.phoneNumber);
    });
  }

  function handleStartPairing() {
    setError(null);
    setAlreadyConnectedNote(false);
    startTransition(async () => {
      const result = await startBablastPairingAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPairingCode(result.data.pairingCode);
      setQrCode(result.data.qrCode);
      if (result.data.alreadyConnected) {
        setAlreadyConnectedNote(true);
        setConnectionState("connected");
      }
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
            <CheckCircle2 className="h-3.5 w-3.5" /> Terhubung{connectedPhone ? ` (${connectedPhone})` : ""}
          </span>
        )}
        {connectionState === "not_connected" && (
          <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            <XCircle className="h-3.5 w-3.5" /> Belum Terhubung
          </span>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {alreadyConnectedNote && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          Nomor sudah terhubung sebelumnya — tidak perlu pairing ulang. Kalau mau ganti nomor, putuskan tautan
          perangkat di WhatsApp HP lama-nya dulu, baru klik "Mulai Pairing" lagi.
        </p>
      )}

      {(pairingCode || qrCode) && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-900">Scan/masukkan kode ini di WhatsApp HP Anda:</p>
          {qrCode && (
            qrImageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrImageDataUrl} alt="QR pairing WhatsApp" className="h-40 w-40 rounded border border-blue-200 bg-white" />
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded border border-blue-200 bg-white">
                <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
              </div>
            )
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
