"use client";

// =============================================================================
// Gate 2I.2 -- Generic confirmation dialog (kontrak §5/§10, GAP G5 -- awalnya
// dialokasikan ke 2I.1 tapi tidak dibangun di sana; 2I.2 adalah domain
// pertama yang benar-benar butuh mutation, jadi dependency ini dipenuhi di
// sini). SATU component dipakai seluruh domain finance (Collection/Payment/
// Reconciliation sekarang, Return/Refund/Cancellation menyusul 2I.3/2I.4) --
// bukan dialog per-domain.
//
// Esc menutup dialog dan mengembalikan fokus ke elemen pemicu (FIN-17-02).
// Idempotency key BUKAN tanggung jawab component ini -- pemanggil men-generate
// key sekali saat dialog dibuka (state form, bukan di sini) sesuai kontrak §5.
// =============================================================================

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  isSubmitting?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Konfirmasi",
  cancelLabel = "Batal",
  danger = false,
  isSubmitting = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      cancelRef.current?.focus();
    } else {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => !isSubmitting && onCancel()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-sm font-semibold text-gray-900">
          {title}
        </h2>
        {description && <p className="mt-1.5 text-xs text-gray-500">{description}</p>}

        {children && <div className="mt-3">{children}</div>}

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={isSubmitting}
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onConfirm}
            className={`rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50 ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {isSubmitting ? "Memproses..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
