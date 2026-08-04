"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Copy, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { resetTenantUserPasswordAction } from "@/lib/tenant-user-password-reset/actions";

interface Props {
  targetUserId: string;
  fullName: string;
  email: string;
}

type Step = "idle" | "confirm" | "result";

export function ResetTenantUserPasswordButton({ targetUserId, fullName, email }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  // Satu-satunya tempat tempPassword pernah disimpan -- state komponen ini,
  // hilang begitu unmount/dismiss. Tidak pernah ditulis ke
  // localStorage/sessionStorage/URL/console (pola identik
  // add-tenant-user-form.tsx).
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleConfirm() {
    // isPending sebagai guard utama double-submit (tombol disabled selama
    // pending) -- pengecekan eksplisit mencegah race klik ganda dari event
    // yang sudah ter-dispatch sebelum re-render disabled diterapkan browser.
    if (isPending) return;
    setError(null);

    startTransition(async () => {
      let result;
      try {
        result = await resetTenantUserPasswordAction(targetUserId);
      } catch {
        setError("Gagal mereset password. Coba lagi atau hubungi administrator.");
        return;
      }

      if (!result.ok || !result.tempPassword) {
        setError(result.error ?? "Gagal mereset password.");
        return;
      }

      setTempPassword(result.tempPassword);
      setStep("result");
    });
  }

  function handleCopy() {
    if (!tempPassword) return;
    navigator.clipboard?.writeText(tempPassword).catch(() => {});
    setCopied(true);
  }

  function handleDismiss() {
    setTempPassword(null);
    setCopied(false);
    setError(null);
    setStep("idle");
    router.refresh();
  }

  if (step === "result" && tempPassword) {
    return (
      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="flex-1">
            <p className="text-xs font-medium text-amber-800">
              Password sementara — catat sekarang, tidak akan ditampilkan lagi.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-md border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-xs text-gray-900">
                {tempPassword}
              </code>
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? "Tersalin" : "Salin"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-amber-700">
              {fullName} wajib mengganti password saat login berikutnya sebelum bisa mengakses dashboard.
            </p>
            <button
              type="button"
              onClick={handleDismiss}
              className="mt-2 w-full rounded-md bg-blue-600 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Selesai
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
        {error && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
        <p className="text-xs text-gray-700">
          Reset password untuk <span className="font-medium">{fullName}</span> ({email})? Password sementara baru
          akan dibuat otomatis, dan user wajib menggantinya saat login berikutnya.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={handleConfirm}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-amber-600 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isPending ? "Memproses..." : "Ya, Reset Password"}
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setStep("idle");
              setError(null);
            }}
            className="flex-1 rounded-md border border-gray-200 bg-white py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
          >
            Batal
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setStep("confirm")}
      className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
    >
      <KeyRound className="h-3.5 w-3.5" />
      Reset Password
    </button>
  );
}
