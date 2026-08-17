"use client";

// =============================================================================
// Gate P4.06 -- Review klaim pembayaran sales/driver (Setujui/Tolak).
// Approve mewajibkan minimal 1 bukti verifikasi Finance (proof, sama pola
// RecordPaymentPanel) + alokasi invoice -- nominal/metode/customer TERKUNCI
// dari klaim asal (tidak bisa diubah di sini, lihat approve_payment_claim_
// atomic). Reject mewajibkan alasan, ledger tidak tersentuh sama sekali.
// =============================================================================

import { useMemo, useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRupiah } from "@/lib/document-engine/monetary";
import type { OutstandingInvoiceOption, PaymentClaimListItem } from "@/lib/finance/queries";
import { approvePaymentClaimAction, rejectPaymentClaimAction } from "@/lib/finance/actions";

interface ProofRow {
  proofType: string;
  objectReference: string;
}

interface PaymentClaimReviewPanelProps {
  claim: PaymentClaimListItem;
  outstandingInvoices: OutstandingInvoiceOption[];
}

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

export function PaymentClaimReviewPanel({ claim, outstandingInvoices }: PaymentClaimReviewPanelProps) {
  const [mode, setMode] = useState<"closed" | "approve" | "reject">("closed");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [proofs, setProofs] = useState<ProofRow[]>([
    { proofType: claim.method === "cash" ? "cash_count_verified" : "bank_statement", objectReference: "" },
  ]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [rejectionReason, setRejectionReason] = useState("");

  const customerInvoices = useMemo(
    () => outstandingInvoices.filter((i) => i.customerId === claim.customerId),
    [outstandingInvoices, claim.customerId]
  );
  const allocationTotal = useMemo(
    () => Object.values(allocations).reduce((sum, v) => sum + (Number(v) || 0), 0),
    [allocations]
  );

  function openApprove() {
    setError(null);
    setProofs([{ proofType: claim.method === "cash" ? "cash_count_verified" : "bank_statement", objectReference: "" }]);
    setAllocations({});
    setMode("approve");
  }

  function openReject() {
    setError(null);
    setRejectionReason("");
    setMode("reject");
  }

  function close() {
    if (isPending) return;
    setMode("closed");
  }

  function toggleInvoice(invoiceId: string, checked: boolean) {
    setAllocations((prev) => {
      const next = { ...prev };
      if (checked) next[invoiceId] = next[invoiceId] ?? "";
      else delete next[invoiceId];
      return next;
    });
  }

  function updateAllocation(invoiceId: string, value: string) {
    setAllocations((prev) => ({ ...prev, [invoiceId]: value }));
  }

  function submitApprove() {
    const filledProofs = proofs.filter((p) => p.proofType.trim() && p.objectReference.trim());
    if (filledProofs.length === 0) {
      setError("Minimal satu bukti verifikasi wajib dilampirkan sebelum menyetujui.");
      return;
    }
    const allocationEntries = Object.entries(allocations).filter(([, v]) => Number(v) > 0);
    if (allocationEntries.length === 0) {
      setError("Minimal satu alokasi invoice wajib diisi.");
      return;
    }
    if (allocationTotal !== claim.amount) {
      setError(`Total alokasi (${formatRupiah(allocationTotal)}) harus sama dengan nominal klaim (${formatRupiah(claim.amount)}).`);
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await approvePaymentClaimAction({
          claimId: claim.id,
          proofs: filledProofs,
          allocations: allocationEntries.map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })),
        });
        setMode("closed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  function submitReject() {
    if (rejectionReason.trim().length < 3) {
      setError("Alasan penolakan wajib diisi (minimal 3 karakter).");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await rejectPaymentClaimAction({ claimId: claim.id, rejectionReason: rejectionReason.trim() });
        setMode("closed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (claim.status !== "PENDING") {
    return <span className="text-xs text-gray-400">-</span>;
  }

  return (
    <>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={openApprove}
          className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
        >
          Setujui
        </button>
        <button
          type="button"
          onClick={openReject}
          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
        >
          Tolak
        </button>
      </div>

      <ConfirmDialog
        open={mode === "approve"}
        title="Setujui Klaim Pembayaran"
        confirmLabel="Setujui & Catat Pembayaran"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitApprove}
        onCancel={close}
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-left">
          <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs">
            <p><span className="text-gray-500">Customer:</span> <span className="font-medium">{claim.customerName}</span></p>
            <p><span className="text-gray-500">Dilaporkan oleh:</span> <span className="font-medium">{claim.claimedByName}</span></p>
            <p><span className="text-gray-500">Metode:</span> <span className="font-medium">{METHOD_LABELS[claim.method] ?? claim.method}</span></p>
            <p><span className="text-gray-500">Nominal diklaim:</span> <span className="font-semibold">{formatRupiah(claim.amount)}</span></p>
            {claim.transferReference && (
              <p><span className="text-gray-500">Ref. Transfer:</span> {claim.transferReference}</p>
            )}
            {claim.note && <p><span className="text-gray-500">Catatan sales:</span> {claim.note}</p>}
            {claim.proofCount === 0 && (
              <p className="text-amber-600">Sales tidak melampirkan bukti apa pun -- bukti verifikasi di bawah ini wajib diisi Finance.</p>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-gray-600">Bukti Verifikasi Finance (wajib)</p>
            <div className="mt-1 space-y-2">
              {proofs.map((proof, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Jenis bukti (mis. bank_statement)"
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
            <p className={`mt-2 text-xs font-medium ${allocationTotal === claim.amount ? "text-green-600" : "text-amber-600"}`}>
              Total alokasi: {formatRupiah(allocationTotal)} / {formatRupiah(claim.amount)}
            </p>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={mode === "reject"}
        title="Tolak Klaim Pembayaran"
        confirmLabel="Tolak Klaim"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitReject}
        onCancel={close}
      >
        <div className="space-y-2 text-left text-xs">
          <p className="text-gray-500">
            Klaim dari <span className="font-medium text-gray-700">{claim.claimedByName}</span> untuk{" "}
            <span className="font-medium text-gray-700">{claim.customerName}</span> ({formatRupiah(claim.amount)}) akan
            ditolak. Ledger tidak akan tersentuh sama sekali.
          </p>
          <label className="block font-medium text-gray-600">
            Alasan Penolakan
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}
