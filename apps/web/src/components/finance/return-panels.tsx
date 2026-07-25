"use client";

// =============================================================================
// Gate 2I.3 -- Retur & Credit Note: form pengajuan (kontrak §5.5) + tombol
// verifikasi Owner-only. RequestReturnPanel dipakai di halaman detail invoice
// (invoice.lines sudah tersedia server-side di sana, kontrak §6 "link ke
// return/credit note terkait"). VerifyReturnPanel dipakai di halaman detail
// retur -- approve/reject memanggil RPC canonical TANPA update langsung ke
// invoice/ledger/credit_note dari sisi client (§4 aturan penting).
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { requestReturnAction, verifyReturnAction } from "@/lib/finance/actions";
import type { InvoiceDetailLine } from "@/lib/finance/queries";

interface RequestReturnPanelProps {
  invoiceId: string;
  lines: InvoiceDetailLine[];
  canRequest: boolean;
}

export function RequestReturnPanel({ invoiceId, lines, canRequest }: RequestReturnPanelProps) {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [reasonCode, setReasonCode] = useState("");
  const [proofReference, setProofReference] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  function openDialog() {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setReasonCode("");
    setProofReference("");
    setQuantities({});
    setOpen(true);
  }

  function closeDialog() {
    if (isPending) return;
    setOpen(false);
  }

  function submit() {
    if (!reasonCode.trim()) {
      setError("Alasan retur wajib diisi.");
      return;
    }
    if (!proofReference.trim()) {
      setError("Referensi bukti retur wajib diisi.");
      return;
    }
    const items = Object.entries(quantities)
      .filter(([, v]) => Number(v) > 0)
      .map(([invoiceLineId, v]) => ({ invoiceLineId, requestedQuantity: Number(v) }));
    if (items.length === 0) {
      setError("Pilih minimal satu item dengan kuantitas retur.");
      return;
    }

    setError(null);
    startTransition(async () => {
      try {
        await requestReturnAction({
          invoiceId,
          items,
          reasonCode: reasonCode.trim(),
          proofReference: proofReference.trim(),
          idempotencyKey,
        });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canRequest) {
    return (
      <button
        type="button"
        disabled
        title="Bukan kewenangan Anda"
        aria-describedby="request-return-disabled-reason"
        className="cursor-not-allowed rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-300"
      >
        Ajukan Retur
        <span id="request-return-disabled-reason" className="sr-only">
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
        Ajukan Retur
      </button>
      <ConfirmDialog
        open={open}
        title="Ajukan Retur"
        description="Retur akan menunggu verifikasi Owner. Invoice dan piutang tidak berubah sampai retur disetujui."
        confirmLabel="Ajukan Retur"
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={closeDialog}
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-left">
          <label className="block text-xs font-medium text-gray-600">
            Alasan Retur
            <input
              type="text"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              placeholder="mis. barang rusak"
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Referensi Bukti Retur
            <input
              type="text"
              value={proofReference}
              onChange={(e) => setProofReference(e.target.value)}
              placeholder="Referensi/tautan bukti"
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <div>
            <p className="text-xs font-medium text-gray-600">Item yang Diretur</p>
            <div className="mt-1 space-y-1.5">
              {lines.map((line) => (
                <div key={line.id} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate">{line.productName}</span>
                  <span className="text-gray-400">Ditagih: {line.quantity}</span>
                  <input
                    type="number"
                    min={0}
                    max={line.quantity}
                    value={quantities[line.id] ?? ""}
                    onChange={(e) => setQuantities((prev) => ({ ...prev, [line.id]: e.target.value }))}
                    className="w-24 rounded-lg border border-gray-200 px-2 py-1 text-xs"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

interface VerifyReturnPanelProps {
  returnId: string;
  canVerify: boolean;
}

export function VerifyReturnPanel({ returnId, canVerify }: VerifyReturnPanelProps) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openDialog(next: "approve" | "reject") {
    setError(null);
    setDecision(next);
    setOpen(true);
  }

  function submit() {
    if (!decision) return;
    setError(null);
    startTransition(async () => {
      try {
        await verifyReturnAction({ returnId, decision });
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  if (!canVerify) {
    return (
      <span
        title="Hanya Owner yang dapat menyetujui"
        aria-describedby="verify-return-disabled-reason"
        className="cursor-not-allowed text-xs font-medium text-gray-300"
      >
        Verifikasi Retur (Hanya Owner)
        <span id="verify-return-disabled-reason" className="sr-only">
          Hanya Owner yang dapat menyetujui
        </span>
      </span>
    );
  }

  return (
    <>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => openDialog("approve")}
          className="rounded-lg bg-green-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-green-700"
        >
          Setujui Retur
        </button>
        <button
          type="button"
          onClick={() => openDialog("reject")}
          className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700"
        >
          Tolak Retur
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title={decision === "approve" ? "Setujui Retur" : "Tolak Retur"}
        description={
          decision === "approve"
            ? "Menyetujui retur akan menerbitkan credit note secara otomatis dan dapat mengurangi piutang invoice terkait sebesar nilai yang dihitung server."
            : "Menolak retur tidak mengubah invoice, piutang, atau ledger sama sekali."
        }
        confirmLabel={decision === "approve" ? "Setujui" : "Tolak"}
        danger={decision === "reject"}
        isSubmitting={isPending}
        error={error}
        onConfirm={submit}
        onCancel={() => !isPending && setOpen(false)}
      />
    </>
  );
}
