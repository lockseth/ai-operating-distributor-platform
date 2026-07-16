"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Link2, Loader2, Unlink } from "lucide-react";
import {
  createTelegramEnrollmentAction,
  disconnectTelegramIdentityAction,
} from "@/lib/telegram-enrollment/actions";

interface ActiveIdentity {
  username: string | null;
}

export function TelegramEnrollmentControl({
  salesmanId,
  activeIdentity,
}: {
  salesmanId: string;
  activeIdentity: ActiveIdentity | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  function createEnrollment() {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      const result = await createTelegramEnrollmentAction(salesmanId);
      if (!result.ok || !result.enrollment) {
        setError(result.error ?? "Kode Telegram tidak dapat dibuat.");
        return;
      }
      setCommand(result.enrollment.command);
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
      const result = await disconnectTelegramIdentityAction(salesmanId);
      setConfirmDisconnect(false);
      if (!result.ok) {
        setError(result.error ?? "Koneksi Telegram tidak dapat diputuskan.");
        return;
      }
      setCommand(null);
      setDeepLink(null);
      setExpiresAt(null);
      router.refresh();
    });
  }

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setError("Salin otomatis gagal. Pilih dan salin kode secara manual.");
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

  return (
    <div className="space-y-2">
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
        Buat tautan Telegram
      </button>

      {command && (
        <div className="max-w-72 rounded-lg border border-blue-100 bg-blue-50 p-2.5">
          <p className="mb-1 text-xs font-medium text-blue-900">
            Kirim kepada Salesman — hanya berlaku sekali
          </p>
          <code className="block break-all rounded bg-white px-2 py-1 text-[11px] text-gray-700">
            {command}
          </code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={copyCommand}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Tersalin" : "Salin"}
            </button>
            {deepLink && (
              <a
                href={deepLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Buka Telegram
              </a>
            )}
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
