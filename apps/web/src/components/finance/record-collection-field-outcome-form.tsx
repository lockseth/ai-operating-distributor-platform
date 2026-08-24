"use client";

// =============================================================================
// Catat Hasil Kunjungan Penagihan (sisi sales/driver, non-pembayaran) --
// pola sama SubmitPaymentClaimForm. BEDA penting: outcome di sini SELALU
// non-pembayaran (contacted_successfully/not_contactable/not_paid_yet/
// dispute) -- untuk lapor "sudah terima uang" tetap wajib pakai form Klaim
// Pembayaran di atas (direview Finance), bukan form ini. Invoice WAJIB
// dipilih (beda dari Klaim Pembayaran yang opsional) -- hasil kunjungan
// penagihan harus terkait 1 tagihan spesifik.
// =============================================================================

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { recordCollectionFieldOutcomeAction, type CollectionFieldOutcome } from "@/lib/finance/actions";
import { formatRupiah } from "@/lib/document-engine/monetary";
import type { OutstandingInvoiceOption } from "@/lib/finance/queries";

interface CustomerOption {
  id: string;
  name: string;
}

interface RecordCollectionFieldOutcomeFormProps {
  customers: CustomerOption[];
  outstandingInvoices: OutstandingInvoiceOption[];
}

const OUTCOME_OPTIONS: { value: CollectionFieldOutcome; label: string }[] = [
  { value: "contacted_successfully", label: "Berhasil ketemu/dihubungi" },
  { value: "not_contactable", label: "Tidak bisa dihubungi" },
  { value: "not_paid_yet", label: "Belum bisa bayar" },
  { value: "dispute", label: "Ada keberatan/sengketa jumlah" },
];

function formatDueDate(iso: string | null): string {
  if (!iso) return "tanpa jatuh tempo";
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export function RecordCollectionFieldOutcomeForm({ customers, outstandingInvoices }: RecordCollectionFieldOutcomeFormProps) {
  const router = useRouter();
  const [customerId, setCustomerId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [outcome, setOutcome] = useState<CollectionFieldOutcome>("not_paid_yet");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const customerInvoices = useMemo(
    () => outstandingInvoices.filter((i) => i.customerId === customerId),
    [outstandingInvoices, customerId]
  );

  function selectCustomer(id: string) {
    setCustomerId(id);
    setInvoiceId("");
  }

  function reset() {
    setCustomerId("");
    setInvoiceId("");
    setOutcome("not_paid_yet");
    setNote("");
  }

  function submit() {
    if (!customerId) {
      setError("Pilih customer terlebih dahulu.");
      return;
    }
    if (!invoiceId) {
      setError("Pilih tagihan yang dikunjungi.");
      return;
    }

    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        await recordCollectionFieldOutcomeAction({
          invoiceId,
          outcome,
          note: note.trim() || null,
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
      <h2 className="text-sm font-semibold text-gray-900">Catat Hasil Kunjungan Penagihan</h2>
      <p className="mt-1 text-xs text-gray-500">
        Toko belum bayar / janji bayar / sengketa jumlah -- <b>BUKAN</b> untuk lapor sudah terima uang (pakai form
        "Lapor Pembayaran Diterima" di atas).
      </p>

      {success && (
        <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
          Hasil kunjungan tercatat.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <label className="block text-xs font-medium text-gray-600">
          Customer
          <select
            value={customerId}
            onChange={(e) => selectCustomer(e.target.value)}
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

        {customerId && (
          <label className="block text-xs font-medium text-gray-600">
            Tagihan yang Dikunjungi
            {customerInvoices.length === 0 ? (
              <p className="mt-1 text-xs text-gray-400">Customer ini tidak punya invoice outstanding.</p>
            ) : (
              <select
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
              >
                <option value="">Pilih tagihan…</option>
                {customerInvoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoiceNumber} -- {formatRupiah(inv.outstandingBalance)} ({formatDueDate(inv.dueDate)})
                  </option>
                ))}
              </select>
            )}
          </label>
        )}

        <fieldset className="block text-xs font-medium text-gray-600">
          <legend className="mb-1">Hasil Kunjungan</legend>
          <div className="space-y-1.5 rounded-lg border border-gray-100 bg-gray-50 p-2.5">
            {OUTCOME_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-xs font-normal text-gray-700">
                <input
                  type="radio"
                  name="collection-field-outcome"
                  checked={outcome === opt.value}
                  onChange={() => setOutcome(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block text-xs font-medium text-gray-600">
          Catatan (opsional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="mis. janji bayar minggu depan setelah gajian"
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
          />
        </label>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="w-full rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending ? "Menyimpan…" : "Catat Hasil"}
        </button>
      </div>
    </div>
  );
}
