"use client";

// =============================================================================
// Gate P4.06 -- Form lapor pembayaran yang diterima sales/driver "all-in"
// langsung dari customer. TIDAK menyentuh receivable_ledger -- status
// PENDING sampai Owner/Finance approve/reject (lihat Klaim Pembayaran di
// Finance Operations). Bukti OPSIONAL (keputusan sementara, lihat
// migration 20261010000001) -- proof_type/object_reference TEKS bebas,
// bukan upload file (belum ada storage-upload primitive di design system,
// pola sama RecordPaymentPanel Gate 2D).
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitPaymentClaimAction } from "@/lib/finance/actions";

interface CustomerOption {
  id: string;
  name: string;
}

interface ProofRow {
  proofType: string;
  objectReference: string;
}

interface SubmitPaymentClaimFormProps {
  customers: CustomerOption[];
}

export function SubmitPaymentClaimForm({ customers }: SubmitPaymentClaimFormProps) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [amount, setAmount] = useState("");
  const [transferReference, setTransferReference] = useState("");
  const [note, setNote] = useState("");
  const [proofs, setProofs] = useState<ProofRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const amountNumber = Number(amount) || 0;

  function reset() {
    setCustomerId("");
    setMethod("cash");
    setAmount("");
    setTransferReference("");
    setNote("");
    setProofs([]);
  }

  function submit() {
    if (!customerId) {
      setError("Pilih customer terlebih dahulu.");
      return;
    }
    if (amountNumber <= 0) {
      setError("Nominal harus lebih besar dari nol.");
      return;
    }
    const filledProofs = proofs.filter((p) => p.proofType.trim() && p.objectReference.trim());

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await submitPaymentClaimAction({
          customerId,
          method,
          amount: amountNumber,
          transferReference: method === "bank_transfer" ? transferReference.trim() || null : null,
          note: note.trim() || null,
          proofs: filledProofs,
          idempotencyKey: crypto.randomUUID(),
        });
        reset();
        setSuccess(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-gray-900">Lapor Pembayaran Diterima</h2>
      <p className="mt-1 text-xs text-gray-500">
        Laporan ini BELUM langsung tercatat sebagai pembayaran resmi -- menunggu diperiksa & disetujui Owner/Finance
        terlebih dahulu.
      </p>

      {success && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
          Laporan terkirim, menunggu review Owner/Finance.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <label className="block text-xs font-medium text-gray-600">
          Customer
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
          >
            <option value="">Pilih customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-gray-600">
            Metode
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as "cash" | "bank_transfer")}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              <option value="cash">Tunai</option>
              <option value="bank_transfer">Transfer Bank</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Nominal Diterima
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
        </div>

        {method === "bank_transfer" && (
          <label className="block text-xs font-medium text-gray-600">
            No. Referensi Transfer (jika ada)
            <input
              type="text"
              value={transferReference}
              onChange={(e) => setTransferReference(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
        )}

        <label className="block text-xs font-medium text-gray-600">
          Catatan (opsional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="mis. toko bayar cash pas dianter"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
          />
        </label>

        <div>
          <p className="text-xs font-medium text-gray-600">Bukti (opsional)</p>
          <div className="mt-1 space-y-2">
            {proofs.map((proof, idx) => (
              <div key={idx} className="flex gap-2">
                <input
                  type="text"
                  placeholder="Jenis bukti (mis. foto struk)"
                  value={proof.proofType}
                  onChange={(e) =>
                    setProofs((prev) => prev.map((p, i) => (i === idx ? { ...p, proofType: e.target.value } : p)))
                  }
                  className="w-2/5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                />
                <input
                  type="text"
                  placeholder="Referensi/tautan bukti"
                  value={proof.objectReference}
                  onChange={(e) =>
                    setProofs((prev) => prev.map((p, i) => (i === idx ? { ...p, objectReference: e.target.value } : p)))
                  }
                  className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={() => setProofs((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-xs text-red-500"
                >
                  Hapus
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setProofs((prev) => [...prev, { proofType: "", objectReference: "" }])}
              className="text-xs font-medium text-blue-600 hover:underline"
            >
              + Tambah Bukti
            </button>
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="w-full rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending ? "Mengirim…" : "Kirim Laporan"}
        </button>
      </div>
    </div>
  );
}
