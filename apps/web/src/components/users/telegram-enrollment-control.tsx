"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Link2, Loader2, Unlink } from "lucide-react";
import {
  createTelegramEnrollmentAction,
  disconnectTelegramIdentityAction,
} from "@/lib/telegram-enrollment/actions";
import type { SalesmanTelegramStatus } from "@/lib/salesman/status";

interface ActiveIdentity {
  username: string | null;
}

const PENDING_STATUS_LABEL: Partial<Record<SalesmanTelegramStatus, string>> = {
  pairing_active: "Pairing Code Aktif",
  pairing_expired: "Pairing Kedaluwarsa",
  disconnected: "Diputuskan/Dicabut",
};

const PENDING_STATUS_COLOR: Partial<Record<SalesmanTelegramStatus, string>> = {
  pairing_active: "bg-blue-50 text-blue-700",
  pairing_expired: "bg-amber-50 text-amber-700",
  disconnected: "bg-gray-100 text-gray-500",
};

export function TelegramEnrollmentControl({
  targetUserId,
  targetName,
  targetRoleLabel,
  activeIdentity,
  status,
}: {
  targetUserId: string;
  targetName: string;
  targetRoleLabel: string;
  activeIdentity: ActiveIdentity | null;
  status: SalesmanTelegramStatus;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [configError, setConfigError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  function createEnrollment() {
    setError(null);
    setCopied(false);
    setConfigError(false);
    startTransition(async () => {
      const result = await createTelegramEnrollmentAction(targetUserId);
      if (!result.ok || !result.enrollment) {
        setError(result.error ?? "Kode Telegram tidak dapat dibuat.");
        return;
      }
      if (!result.enrollment.deepLink) {
        // Token sudah diterbitkan di backend, tapi TELEGRAM_BOT_USERNAME
        // kosong/tidak valid -- fail closed, jangan fallback ke token mentah.
        setDeepLink(null);
        setExpiresAt(null);
        setConfigError(true);
        return;
      }
      setDeepLink(result.enrollment.deepLink);
      setExpiresAt(result.enrollment.expiresAt);
    });
  }

  function disconnect() {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await disconnectTelegramIdentityAction(targetUserId);
      setConfirmDisconnect(false);
      if (!result.ok) {
        setError(result.error ?? "Koneksi Telegram tidak dapat diputuskan.");
        return;
      }
      setDeepLink(null);
      setExpiresAt(null);
      setConfigError(false);
      router.refresh();
    });
  }

  async function copyPairingLink() {
    if (!deepLink) return;
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
    } catch {
      setError("Salin otomatis gagal. Tautan tetap bisa diklik langsung.");
    }
  }

  if (activeIdentity) {
    return (
      <div className="space-y-1.5">
        <div>
          <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
            Terhubung
            {activeIdentity.username ? ` · @${activeIdentity.username}` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={disconnect}
          disabled={isPending}
          className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-60"
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Unlink className="h-3.5 w-3.5" />
          )}
          {confirmDisconnect ? "Konfirmasi putuskan" : "Putuskan"}
        </button>
        {confirmDisconnect && (
          <p className="max-w-52 text-xs text-amber-700">
            Koneksi dan percakapan aktif akan dihentikan.
          </p>
        )}
        {error && <p className="max-w-52 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  const pendingLabel = PENDING_STATUS_LABEL[status];

  return (
    <div className="space-y-2">
      {pendingLabel && (
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PENDING_STATUS_COLOR[status] ?? "bg-gray-100 text-gray-500"}`}
        >
          {pendingLabel}
        </span>
      )}
      <button
        type="button"
        onClick={createEnrollment}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Link2 className="h-3.5 w-3.5" />
        )}
        {status === "not_connected" ? "Buat tautan Telegram" : "Terbitkan ulang tautan"}
      </button>

      {configError && (
        <div className="max-w-72 rounded-lg border border-red-100 bg-red-50 p-2.5">
          <p className="text-xs font-medium text-red-700">
            Konfigurasi bot Telegram belum lengkap. Hubungi admin sistem
            sebelum mengirim tautan pairing.
          </p>
        </div>
      )}

      {deepLink && (
        <div className="max-w-72 rounded-lg border border-blue-100 bg-blue-50 p-2.5">
          <p className="mb-1 text-xs font-medium text-blue-900">
            Untuk {targetName} · {targetRoleLabel}
          </p>
          <p className="mb-1.5 text-[11px] text-blue-700">
            Tautan sekali pakai — kirim hanya kepada {targetName}, jangan
            dibagikan ke pihak lain.
          </p>
          <code className="block break-all rounded bg-white px-2 py-1 text-[11px] text-gray-700">
            {deepLink}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={deepLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Buka Telegram
            </a>
            <button
              type="button"
              onClick={copyPairingLink}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Tersalin" : "Salin Tautan Pairing"}
            </button>
          </div>
          {expiresAt && (
            <p className="mt-1.5 text-[11px] text-blue-700">
              Kedaluwarsa{" "}
              {new Date(expiresAt).toLocaleTimeString("id-ID", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      )}

      {error && <p className="max-w-72 text-xs text-red-600">{error}</p>}
    </div>
  );
}
