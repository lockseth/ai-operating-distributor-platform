"use client";

// =============================================================================
// Gate 2I.2 -- Exception Rekonsiliasi (kontrak §5.4). "Koreksi Rekonsiliasi"
// (correct_payment_reconciliation) wajib menyertakan alasan (REASON_REQUIRED)
// -- ConfirmDialog generic dipakai dengan field alasan.
// =============================================================================

import { useState, useTransition } from "react";
import Link from "next/link";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import type { ReconciliationExceptionListItem, ReconciliationHistoryEntry } from "@/lib/finance/queries";
import { correctPaymentReconciliationAction } from "@/lib/finance/actions";

interface ReconciliationPanelProps {
  exceptions: ReconciliationExceptionListItem[];
  historyByReceipt: Record<string, ReconciliationHistoryEntry[]>;
  canReconcile: boolean;
}

export function ReconciliationPanel({ exceptions, historyByReceipt, canReconcile }: ReconciliationPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialogFor, setDialogFor] = useState<ReconciliationExceptionListItem | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openDialog(item: ReconciliationExceptionListItem) {
    setError(null);
    setReason("");
    setIdempotencyKey(crypto.randomUUID());
    setDialogFor(item);
  }

  function closeDialog() {
    if (isPending) return;
    setDialogFor(null);
  }

  function submit() {
    if (!dialogFor) return;
    if (!reason.trim()) {
      setError("Alasan koreksi wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await correctPaymentReconciliationAction({
          reconciliationId: dialogFor.id,
          paymentReceiptId: dialogFor.paymentReceiptId,
          reason: reason.trim(),
          idempotencyKey,
        });
        setDialogFor(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (exceptions.length === 0) {
    return (
      <EmptyState
        title="Tidak ada exception rekonsiliasi"
        description="Seluruh pembayaran yang sudah direkonsiliasi cocok (matched)."
      />
    );
  }

  return (
    <div className="space-y-3">
      {exceptions.map((item) => {
        const history = historyByReceipt[item.paymentReceiptId] ?? [];
        const isExpanded = expanded === item.paymentReceiptId;
        return (
          <div key={item.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={item.classification} domain="payment_reconciliation" />
                  <Link
                    href={`/dashboard/finance/payments/${item.paymentReceiptId}`}
                    className="font-mono text-xs font-semibold text-blue-600 hover:underline"
                  >
                    {item.paymentReceiptId.slice(0, 8)}…
                  </Link>
                </div>
                <p className="mt-1 text-xs text-gray-500">{item.customerName}</p>
                <p className="mt-0.5 text-xs text-gray-400">{formatJakartaDateTime(item.createdAt)}</p>
              </div>
              <div className="text-right text-xs text-gray-500">
                <p>Nominal: {formatRupiah(item.paymentAmount)}</p>
                <p>Teralokasi: {formatRupiah(item.totalAllocated)}</p>
                <p>Belum teralokasi: {formatRupiah(item.unallocatedAmount)}</p>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : item.paymentReceiptId)}
                className="text-xs font-medium text-gray-500 hover:underline"
              >
                {isExpanded ? "Sembunyikan riwayat" : `Lihat riwayat (${history.length})`}
              </button>
              {canReconcile ? (
                <button
                  type="button"
                  onClick={() => openDialog(item)}
                  className="text-xs font-medium text-blue-600 hover:underline"
                >
                  Koreksi Rekonsiliasi
                </button>
              ) : (
                <span title="Bukan kewenangan Anda" className="text-xs text-gray-300">
                  Koreksi Rekonsiliasi (Bukan kewenangan Anda)
                </span>
              )}
            </div>

            {isExpanded && (
              <ul className="mt-3 space-y-1.5 border-t border-gray-100 pt-3">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between text-xs text-gray-500">
                    <span>
                      <StatusBadge status={h.classification} domain="payment_reconciliation" /> {formatJakartaDateTime(h.createdAt)}
                    </span>
                    {h.reason && <span className="text-gray-400">Alasan: {h.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={dialogFor !== null}
        title="Koreksi Rekonsiliasi"
        description="Koreksi menulis baris baru (append-only) -- riwayat lama tetap tersimpan."
        confirmLabel="Simpan Koreksi"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={closeDialog}
      >
        <label className="block text-left text-xs font-medium text-gray-600">
          Alasan
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            rows={2}
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
