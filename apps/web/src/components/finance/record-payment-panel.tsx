"use client";

// =============================================================================
// Gate 2I.2 -- Pembayaran & Verifikasi: form "Catat Pembayaran" (kontrak
// §5.3). Proof direpresentasikan sebagai referensi objek (proof_type +
// object_reference) -- object_reference sekarang diisi PATH STORAGE hasil
// upload sungguhan (bucket payment-proofs), bukan lagi teks/link ketikan
// manual (perbaikan 2026-08-24, lihat TRACKER.md). Running total alokasi vs
// nominal ditampilkan real-time sebagai bantuan UX -- validasi final tetap
// RPC (§5.3: "bukan menggantikan validasi server").
// =============================================================================

import { useMemo, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRupiah } from "@/lib/document-engine/monetary";
import type { CustomerWithOutstandingOption, OutstandingInvoiceOption } from "@/lib/finance/queries";
import { recordVerifiedPaymentAction } from "@/lib/finance/actions";
import { uploadPaymentProofAction } from "@/lib/finance/proof-upload-actions";

type ProofUploadStatus = "idle" | "uploading" | "done" | "error";

interface ProofRow {
  proofType: string;
  objectReference: string;
  fileName: string;
  uploadStatus: ProofUploadStatus;
  uploadError: string | null;
}

interface RecordPaymentPanelProps {
  customers: CustomerWithOutstandingOption[];
  outstandingInvoices: OutstandingInvoiceOption[];
  canRecord: boolean;
}

export function RecordPaymentPanel({ customers, outstandingInvoices, canRecord }: RecordPaymentPanelProps) {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [customerId, setCustomerId] = useState("");
  const [method, setMethod] = useState<"cash" | "bank_transfer">("cash");
  const [amount, setAmount] = useState("");
  const [transferReference, setTransferReference] = useState("");
  const [proofs, setProofs] = useState<ProofRow[]>([
    { proofType: "bank_transfer_receipt", objectReference: "", fileName: "", uploadStatus: "idle", uploadError: null },
  ]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const customerInvoices = useMemo(
    () => outstandingInvoices.filter((i) => i.customerId === customerId),
    [outstandingInvoices, customerId]
  );

  const allocationTotal = useMemo(
    () => Object.values(allocations).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [allocations]
  );
  const amountNumber = Number(amount) || 0;

  function openDialog() {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setCustomerId("");
    setMethod("cash");
    setAmount("");
    setTransferReference("");
    setProofs([{ proofType: "cash_receipt", objectReference: "", fileName: "", uploadStatus: "idle", uploadError: null }]);
    setAllocations({});
    setOpen(true);
  }

  function closeDialog() {
    if (isPending) return;
    setOpen(false);
  }

  function updateAllocation(invoiceId: string, value: string) {
    setAllocations((prev) => ({ ...prev, [invoiceId]: value }));
  }

  function toggleInvoice(invoiceId: string, checked: boolean) {
    setAllocations((prev) => {
      const next = { ...prev };
      if (checked) next[invoiceId] = next[invoiceId] ?? "";
      else delete next[invoiceId];
      return next;
    });
  }

  async function handleProofFileChange(idx: number, file: File | null) {
    if (!file) return;
    setProofs((prev) => prev.map((p, i) => (i === idx ? { ...p, uploadStatus: "uploading", uploadError: null } : p)));

    const formData = new FormData();
    formData.set("file", file);
    const result = await uploadPaymentProofAction(formData);

    setProofs((prev) =>
      prev.map((p, i) =>
        i === idx
          ? result.ok
            ? { ...p, objectReference: result.path!, fileName: file.name, uploadStatus: "done", uploadError: null }
            : { ...p, objectReference: "", fileName: "", uploadStatus: "error", uploadError: result.error ?? "Gagal mengunggah." }
          : p,
      ),
    );
  }

  function submit() {
    if (!customerId) {
      setError("Pilih customer terlebih dahulu.");
      return;
    }
    if (amountNumber <= 0) {
      setError("Nominal pembayaran harus lebih besar dari nol.");
      return;
    }
    if (proofs.some((p) => p.uploadStatus === "uploading")) {
      setError("Tunggu sampai semua bukti selesai diunggah.");
      return;
    }
    const filledProofs = proofs.filter((p) => p.proofType.trim() && p.objectReference.trim() && p.uploadStatus === "done");
    if (filledProofs.length === 0) {
      setError("Minimal satu bukti pembayaran wajib diunggah.");
      return;
    }
    const allocationEntries = Object.entries(allocations).filter(([, v]) => Number(v) > 0);
    if (allocationEntries.length === 0) {
      setError("Minimal satu alokasi invoice wajib diisi.");
      return;
    }
    if (allocationTotal !== amountNumber) {
      setError("Total alokasi harus sama dengan nominal pembayaran.");
      return;
    }
    if (method === "bank_transfer" && !transferReference.trim()) {
      setError("Nomor referensi transfer wajib diisi untuk metode transfer bank.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await recordVerifiedPaymentAction({
          method,
          amount: amountNumber,
          proofs: filledProofs,
          allocations: allocationEntries.map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })),
          transferReference: method === "bank_transfer" ? transferReference.trim() : null,
          idempotencyKey,
        });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canRecord) {
    return (
      <button
        type="button"
        disabled
        title="Bukan kewenangan Anda"
        aria-describedby="record-payment-disabled-reason"
        className="cursor-not-allowed rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-300"
      >
        Catat Pembayaran
        <span id="record-payment-disabled-reason" className="sr-only">
          Bukan kewenangan Anda
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700"
      >
        Catat Pembayaran
      </button>

      <ConfirmDialog
        open={open}
        title="Catat Pembayaran"
        confirmLabel="Simpan Pembayaran"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={closeDialog}
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-left">
          <label className="block text-xs font-medium text-gray-600">
            Customer
            <select
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                setAllocations({});
              }}
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
              Nominal Pembayaran
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
              No. Referensi Transfer
              <input
                type="text"
                value={transferReference}
                onChange={(e) => setTransferReference(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
              />
            </label>
          )}

          <div>
            <p className="text-xs font-medium text-gray-600">Bukti Pembayaran</p>
            <div className="mt-1 space-y-2">
              {proofs.map((proof, idx) => (
                <div key={idx} className="flex flex-col gap-1 rounded-lg border border-gray-200 p-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Jenis bukti (mis. bank_transfer_receipt)"
                      value={proof.proofType}
                      onChange={(e) =>
                        setProofs((prev) => prev.map((p, i) => (i === idx ? { ...p, proofType: e.target.value } : p)))
                      }
                      className="w-2/5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                    />
                    <label className="flex-1 cursor-pointer rounded-lg border border-dashed border-gray-300 px-2.5 py-1.5 text-center text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600">
                      {proof.uploadStatus === "uploading" ? "Mengunggah…" : proof.fileName || "Pilih file bukti (foto/PDF)"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                        className="hidden"
                        onChange={(e) => handleProofFileChange(idx, e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {proofs.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setProofs((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-xs text-red-500"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                  {proof.uploadStatus === "done" && <p className="text-xs text-green-600">✓ Sudah terunggah</p>}
                  {proof.uploadStatus === "error" && <p className="text-xs text-red-500">{proof.uploadError}</p>}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setProofs((prev) => [
                    ...prev,
                    { proofType: "", objectReference: "", fileName: "", uploadStatus: "idle", uploadError: null },
                  ])
                }
                className="text-xs font-medium text-blue-600 hover:underline"
              >
                + Tambah Bukti
              </button>
            </div>
          </div>

          {customerId && (
            <div>
              <p className="text-xs font-medium text-gray-600">Alokasi Invoice</p>
              {customerInvoices.length === 0 ? (
                <p className="mt-1 text-xs text-gray-400">Customer ini tidak memiliki invoice outstanding.</p>
              ) : (
                <div className="mt-1 space-y-1.5">
                  {customerInvoices.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={inv.id in allocations}
                        onChange={(e) => toggleInvoice(inv.id, e.target.checked)}
                      />
                      <span className="flex-1 font-mono">{inv.invoiceNumber}</span>
                      <span className="text-gray-400">{formatRupiah(inv.outstandingBalance)}</span>
                      <input
                        type="number"
                        min={0}
                        max={inv.outstandingBalance}
                        disabled={!(inv.id in allocations)}
                        value={allocations[inv.id] ?? ""}
                        onChange={(e) => updateAllocation(inv.id, e.target.value)}
                        className="w-28 rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:bg-gray-50"
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className={`mt-2 text-xs font-medium ${allocationTotal === amountNumber ? "text-green-600" : "text-amber-600"}`}>
                Total alokasi: {formatRupiah(allocationTotal)} / {formatRupiah(amountNumber)}
              </p>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
