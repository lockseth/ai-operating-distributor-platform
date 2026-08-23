"use client";

// =============================================================================
// Owner Unlock Inbox -- panel Setujui/Tolak untuk satu pengajuan buka-kunci
// toko PENDING. Approve memberi exception SEKALI PAKAI (dikonsumsi RPC order
// Gate P4.16-C saat order berikutnya untuk toko itu berhasil) -- tidak
// mengubah data lain. Reject mewajibkan alasan, toko tetap terkunci.
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { PendingStoreUnlockRequestItem } from "@/lib/customers/unlock-request-actions";
import { decideStoreUnlockRequestAction } from "@/lib/customers/unlock-request-actions";

interface UnlockRequestReviewPanelProps {
  request: PendingStoreUnlockRequestItem;
}

export function UnlockRequestReviewPanel({ request }: UnlockRequestReviewPanelProps) {
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
        await decideStoreUnlockRequestAction({
          requestId: request.requestId,
          customerId: request.customerId,
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
        title="Setujui Buka Kunci Toko"
        confirmLabel="Setujui"
        isSubmitting={isPending}
        error={error}
        onConfirm={() => submit("APPROVED")}
        onCancel={close}
      >
        <p className="text-left text-xs text-gray-500">
          Toko <span className="font-medium text-gray-700">{request.customerName}</span> akan mendapat izin buka kunci
          <strong> sekali pakai</strong> untuk satu order berikutnya. Setelah order itu berhasil, toko akan otomatis
          terkunci lagi selama tagihan yang sama masih tertunggak.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={mode === "reject"}
        title="Tolak Buka Kunci Toko"
        confirmLabel="Tolak"
        isSubmitting={isPending}
        error={error}
        onConfirm={() => submit("REJECTED")}
        onCancel={close}
      >
        <div className="space-y-2 text-left text-xs">
          <p className="text-gray-500">
            Pengajuan buka kunci untuk toko{" "}
            <span className="font-medium text-gray-700">{request.customerName}</span> akan ditolak. Toko tetap
            terkunci dari order baru.
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
