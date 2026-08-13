"use client";

// =============================================================================
// Gate 3E-D6-B -- Entry point UI Sales untuk mengajukan harga khusus lewat
// RPC existing (LOCKED) submit_special_price_proposal_atomic. Tidak ada
// sistem approval baru -- panel ini murni form input + pemanggilan action
// lib/orders/special-price-proposal-actions.ts. Tombol keputusan Owner
// (approve/reject) SENGAJA tidak ada di sini.
// =============================================================================

import { useState, useTransition } from "react";
import { Tag, Loader2, X } from "lucide-react";
import { submitSpecialPriceProposalAction } from "@/lib/orders/special-price-proposal-actions";

export interface SpecialPriceProposalItemOption {
  id: string;
  productLabel: string;
  unitPrice: number;
  masterPrice: number | null;
}

export interface ExistingSpecialPriceProposal {
  status: "PENDING" | "APPROVED" | "REJECTED";
  proposalVersion: number;
  reason: string | null;
  requestedAt: string;
  decisionReason: string | null;
  decidedAt: string | null;
}

interface SpecialPriceProposalPanelProps {
  orderId: string;
  items: SpecialPriceProposalItemOption[];
  canPropose: boolean;
  latestProposal: ExistingSpecialPriceProposal | null;
}

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_LABEL: Record<ExistingSpecialPriceProposal["status"], string> = {
  PENDING: "Menunggu persetujuan Owner",
  APPROVED: "Harga khusus disetujui",
  REJECTED: "Harga khusus ditolak",
};

const STATUS_CLASS: Record<ExistingSpecialPriceProposal["status"], string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-gray-100 text-gray-600",
};

export function SpecialPriceProposalPanel({ orderId, items, canPropose, latestProposal }: SpecialPriceProposalPanelProps) {
  const [open, setOpen] = useState(false);

  if (!canPropose && !latestProposal) return null;

  const isPendingDecision = latestProposal?.status === "PENDING";

  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <Tag className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-900">Harga Khusus</h2>
      </div>

      {latestProposal && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-1">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASS[latestProposal.status]}`}>
            {STATUS_LABEL[latestProposal.status]}
          </span>
          {latestProposal.reason && (
            <p className="text-xs text-gray-600">Alasan pengajuan: {latestProposal.reason}</p>
          )}
          {latestProposal.status !== "PENDING" && latestProposal.decisionReason && (
            <p className="text-xs text-gray-600">Catatan Owner: {latestProposal.decisionReason}</p>
          )}
          <p className="text-xs text-gray-400">Diajukan {formatDateTime(latestProposal.requestedAt)}</p>
        </div>
      )}

      {canPropose && !isPendingDecision && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-blue-200 px-3.5 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50"
        >
          <Tag className="h-3.5 w-3.5" />
          Ajukan Harga Khusus
        </button>
      )}

      {open && (
        <ProposalDialog
          orderId={orderId}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ProposalDialog({
  orderId,
  items,
  onClose,
}: {
  orderId: string;
  items: SpecialPriceProposalItemOption[];
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [prices, setPrices] = useState<Record<string, string>>(
    () => Object.fromEntries(items.map((item) => [item.id, String(item.unitPrice)]))
  );
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  function toggleItem(itemId: string, checked: boolean) {
    setSelected((prev) => ({ ...prev, [itemId]: checked }));
  }

  function updatePrice(itemId: string, value: string) {
    setPrices((prev) => ({ ...prev, [itemId]: value }));
  }

  function submit() {
    setError(null);
    setInfoMessage(null);

    const selectedItems = items.filter((item) => selected[item.id]);
    if (selectedItems.length === 0) {
      setError("Pilih minimal satu item untuk diajukan harga khususnya.");
      return;
    }
    if (!reason.trim()) {
      setError("Alasan pengajuan wajib diisi.");
      return;
    }

    const parsedItems: { salesOrderItemId: string; proposedUnitPrice: number }[] = [];
    for (const item of selectedItems) {
      const price = Number(prices[item.id]);
      if (!Number.isFinite(price) || price <= 0) {
        setError(`Harga untuk "${item.productLabel}" tidak valid.`);
        return;
      }
      parsedItems.push({ salesOrderItemId: item.id, proposedUnitPrice: price });
    }

    startTransition(async () => {
      try {
        const result = await submitSpecialPriceProposalAction({
          orderId,
          items: parsedItems,
          reason,
          idempotencyKey,
        });

        if (result.outcome === "approval_not_required") {
          setInfoMessage(
            "Harga yang diajukan masih dalam batas kebijakan diskon -- tidak memerlukan persetujuan Owner. Ubah harga langsung lewat Edit Order."
          );
          return;
        }

        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow-lg space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Ajukan Harga Khusus</h3>
          <button type="button" onClick={onClose} disabled={isPending} className="text-gray-400 hover:text-gray-600 disabled:opacity-60">
            <X className="h-4 w-4" />
          </button>
        </div>

        {infoMessage ? (
          <div className="space-y-3">
            <p className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3">{infoMessage}</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-gray-100 px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-200"
            >
              Tutup
            </button>
          </div>
        ) : (
          <>
            <div className="max-h-64 overflow-y-auto space-y-2 border rounded-lg p-3">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={!!selected[item.id]}
                    onChange={(e) => toggleItem(item.id, e.target.checked)}
                    disabled={isPending}
                  />
                  <div className="flex-1">
                    <p className="text-gray-900">{item.productLabel}</p>
                    {item.masterPrice !== null && (
                      <p className="text-xs text-gray-400">Harga master: {formatIDR(item.masterPrice)}</p>
                    )}
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={prices[item.id] ?? ""}
                    onChange={(e) => updatePrice(item.id, e.target.value)}
                    disabled={isPending || !selected[item.id]}
                    className="w-32 rounded-lg border border-gray-200 px-2 py-1 text-right text-sm disabled:bg-gray-50"
                  />
                </div>
              ))}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500">Alasan pengajuan</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={isPending}
                rows={3}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
                placeholder="Jelaskan alasan permintaan harga khusus untuk item di atas"
              />
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isPending}
                className="rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-60"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={isPending}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Kirim Pengajuan
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
