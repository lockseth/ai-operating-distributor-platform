"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignSalesmanAction } from "@/lib/dispatch/actions";
import { UserCheck, Loader2 } from "lucide-react";

interface SalesmanOption {
  id: string;
  fullName: string;
}

const REASON_MAX_LENGTH = 500;

/**
 * Assignment/reassignment Salesman -- delegasi penuh ke assignSalesmanAction
 * (server-side: idempotent, verifikasi tenant+role, alasan wajib hanya saat
 * mengganti assignment yang sudah ada). Konfirmasi material hanya diminta
 * saat benar-benar MENGGANTI Salesman yang sudah ditugaskan.
 */
export function AssignSalesmanForm({
  planId,
  salesmen,
  currentSalesmanId,
}: {
  planId: string;
  salesmen: SalesmanOption[];
  currentSalesmanId: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(currentSalesmanId ?? "");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isReplacement = currentSalesmanId !== null && selected !== currentSalesmanId;

  function submit() {
    setError(null);
    setSuccess(false);
    if (!selected) {
      setError("Pilih Salesman terlebih dahulu.");
      return;
    }
    if (selected === currentSalesmanId) {
      setError(null);
      return; // idempotent: tidak ada perubahan, tidak perlu request
    }
    if (isReplacement && reason.trim().length === 0) {
      setError("Alasan wajib diisi saat mengganti Salesman yang sudah ditugaskan.");
      return;
    }
    if (isReplacement && !confirming) {
      setConfirming(true);
      return;
    }

    startTransition(async () => {
      const result = await assignSalesmanAction(planId, selected, reason.trim() || undefined);
      setConfirming(false);
      if (!result.ok) {
        setError(result.error ?? "Gagal menetapkan Salesman.");
        return;
      }
      setSuccess(true);
      setReason("");
      router.refresh();
    });
  }

  if (salesmen.length === 0) {
    return (
      <p className="text-xs text-gray-500">
        Belum ada user dengan role Salesman di perusahaan ini. Tambahkan lewat halaman Pengguna terlebih dahulu.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-gray-500">Tetapkan / Ganti Salesman</label>
      <div className="flex items-center gap-2">
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setConfirming(false);
            setError(null);
          }}
          disabled={isPending}
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
        >
          <option value="">Belum ditugaskan</option>
          {salesmen.map((s) => (
            <option key={s.id} value={s.id}>
              {s.fullName}
            </option>
          ))}
        </select>
        <button
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
          {confirming ? "Konfirmasi" : "Simpan"}
        </button>
      </div>

      {isReplacement && (
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX_LENGTH))}
          disabled={isPending}
          placeholder="Alasan mengganti Salesman (wajib)…"
          rows={2}
          maxLength={REASON_MAX_LENGTH}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
      )}

      {confirming && (
        <p className="text-xs text-amber-600">Salesman sudah ditugaskan sebelumnya. Klik &quot;Konfirmasi&quot; untuk menyimpan penggantian.</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {success && <p className="text-xs text-green-600">Salesman berhasil ditetapkan.</p>}
    </div>
  );
}
