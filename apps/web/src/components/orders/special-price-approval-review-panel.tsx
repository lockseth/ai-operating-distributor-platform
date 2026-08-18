"use client";

// =============================================================================
// Owner Approval Inbox -- panel Setujui/Tolak untuk satu permintaan harga
// khusus PENDING. Approve tidak butuh input tambahan (RPC decide_special_
// price_proposal_atomic tidak menerima override harga apa pun -- snapshot
// yang diajukan Sales dikunci, lihat migration 20260923000001). Reject
// mewajibkan alasan. Order berpindah ke status 'draft' setelah approve --
// Sales tetap harus konfirmasi ulang order secara terpisah.
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRupiah } from "@/lib/document-engine/monetary";
import type { PendingSpecialPriceProposalItem } from "@/lib/orders/special-price-proposal-actions";
import { decideSpecialPriceProposalAction } from "@/lib/orders/special-price-proposal-actions";

interface SpecialPriceApprovalReviewPanelProps {
  proposal: PendingSpecialPriceProposalItem;
}

export function SpecialPriceApprovalReviewPanel({ proposal }: SpecialPriceApprovalReviewPanelProps) {
  const [mode, setMode] = useState<"closed" | "approve" | "reject">("closed");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [rejectionReason, setRejectionReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  function close() {
    if (isPending) return;
    setMode("closed");
  }

  function openApprove() {
    setError(null);
    setMode("approve");
  }

  function openReject() {
    setError(null);
    setRejectionReason("");
    setMode("reject");
  }

  function submit(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && rejectionReason.trim().length < 3) {
      setError("Alasan penolakan wajib diisi (minimal 3 karakter).");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await decideSpecialPriceProposalAction({
          approvalRequestId: proposal.approvalRequestId,
          orderId: proposal.orderId,
          decision,
          idempotencyKey,
          decisionReason: decision === "REJECTED" ? rejectionReason.trim() : undefined,
        });
        setMode("closed");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
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
        title="Setujui Harga Khusus"
        confirmLabel="Setujui"
        isSubmitting={isPending}
        error={error}
        onConfirm={() => submit("APPROVED")}
        onCancel={close}
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-left text-xs">
          <p className="text-gray-500">
            Order <span className="font-mono font-medium text-gray-700">{proposal.orderNumber}</span> untuk{" "}
            <span className="font-medium text-gray-700">{proposal.customerName}</span> akan mendapat harga khusus
            sesuai yang diajukan Sales di bawah ini. Setelah disetujui, order kembali ke status Draft dan Sales harus
            konfirmasi ulang.
          </p>
          <div className="space-y-1.5 rounded-lg border border-gray-100">
            {proposal.lines.map((line, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2 border-b border-gray-50 px-3 py-2 last:border-b-0">
                <div>
                  <p className="font-medium text-gray-800">{line.productName}</p>
                  <p className="text-gray-400">Qty {line.quantity}</p>
                </div>
                <div className="text-right">
                  <p className="text-gray-400 line-through">{formatRupiah(line.masterUnitPrice)}</p>
                  <p className="font-semibold text-gray-800">{formatRupiah(line.proposedUnitPrice)}</p>
                  <p className="text-amber-600">-{line.impliedDiscountPercentage.toFixed(2)}%</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={mode === "reject"}
        title="Tolak Harga Khusus"
        confirmLabel="Tolak"
        isSubmitting={isPending}
        error={error}
        onConfirm={() => submit("REJECTED")}
        onCancel={close}
      >
        <div className="space-y-2 text-left text-xs">
          <p className="text-gray-500">
            Permintaan harga khusus untuk order{" "}
            <span className="font-mono font-medium text-gray-700">{proposal.orderNumber}</span> akan ditolak. Sales
            dapat mengajukan ulang dengan harga berbeda.
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
