"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDeliveryAuditSampleAction, recordDeliveryAuditResultAction } from "@/lib/delivery/audit-actions";

export function CreateAuditSampleButton() {
  const router = useRouter();
  const [count, setCount] = useState("5");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function create() {
    setMessage(null);
    startTransition(async () => {
      const res = await createDeliveryAuditSampleAction(Number(count));
      setMessage(res.ok ? `${res.created} pengiriman dipilih.` : res.error ?? "Gagal.");
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <label className="text-sm text-gray-700">Jumlah sampel
        <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} className="ml-2 w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
      </label>
      <button type="button" disabled={isPending} onClick={create} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {isPending ? "Memilih…" : "Pilih Sampel Minggu Ini"}
      </button>
      {message && <p role="status" className="text-sm text-gray-600">{message}</p>}
    </div>
  );
}

export function AuditResultForm({ auditId }: { auditId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function record(result: "verified_ok" | "discrepancy") {
    setError(null);
    startTransition(async () => {
      const res = await recordDeliveryAuditResultAction(auditId, result, note);
      if (!res.ok) { setError(res.error ?? "Gagal."); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan hasil telepon (wajib bila tidak sesuai)" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <div className="flex gap-2">
        <button type="button" disabled={isPending} onClick={() => record("verified_ok")} className="rounded-lg bg-green-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60">Sesuai</button>
        <button type="button" disabled={isPending} onClick={() => record("discrepancy")} className="rounded-lg border border-red-300 px-3.5 py-2 text-sm font-semibold text-red-700 disabled:opacity-60">Tidak Sesuai</button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
