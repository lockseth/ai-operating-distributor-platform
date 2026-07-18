"use client";

// =============================================================================
// Human Review panel — Order Cancellation & Dispute. Murni tambahan
// (additive) di halaman detail order, tidak mengubah bagian order_source
// yang sudah ada.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, XCircle, UserX, UserCheck, PauseCircle, Loader2 } from "lucide-react";
import { resolveDisputeRequestAction } from "@/lib/order-disputes/actions";
import { CONTACT_SOURCE_LABEL, ORDER_STAGE_LABEL, RESOLUTION_LABEL, type ContactSource, type OrderStage, type Resolution } from "@/lib/order-disputes/types";

export interface DisputeRequestView {
  id: string;
  requestType: "CUSTOMER_CANCELLED" | "CUSTOMER_DENIES_ORDER";
  reasonCode: string;
  notes: string | null;
  reportedPicName: string | null;
  contactSource: ContactSource;
  orderStageAtRequest: OrderStage;
  aiClassification: string | null;
  status: "REQUESTED" | "ON_HOLD" | "APPROVED" | "REJECTED" | "RESOLVED";
  resolution: Resolution | null;
  resolutionNotes: string | null;
  actualPicName: string | null;
  requestedByName: string;
  requestedById: string;
  requestedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_BADGE: Record<DisputeRequestView["status"], string> = {
  REQUESTED: "bg-amber-50 text-amber-700",
  ON_HOLD: "bg-red-50 text-red-700",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-gray-100 text-gray-600",
  RESOLVED: "bg-blue-50 text-blue-700",
};

const STATUS_LABEL: Record<DisputeRequestView["status"], string> = {
  REQUESTED: "Menunggu Review",
  ON_HOLD: "Ditahan (Hold)",
  APPROVED: "Disetujui",
  REJECTED: "Ditolak",
  RESOLVED: "Selesai",
};

export function DisputeReviewPanel({
  requests,
  salesOrderId,
  canReview,
  currentUserId,
}: {
  requests: DisputeRequestView[];
  salesOrderId: string;
  canReview: boolean;
  currentUserId: string;
}) {
  if (requests.length === 0) return null;

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-semibold text-gray-900">Pembatalan &amp; Sengketa Order</h2>
        <span className="ml-auto text-xs text-gray-400">{requests.length} permintaan</span>
      </div>
      <div className="divide-y divide-gray-100">
        {requests.map((r) => (
          <DisputeRequestCard
            key={r.id}
            request={r}
            salesOrderId={salesOrderId}
            canReview={canReview}
            currentUserId={currentUserId}
          />
        ))}
      </div>
    </div>
  );
}

function DisputeRequestCard({
  request,
  salesOrderId,
  canReview,
  currentUserId,
}: {
  request: DisputeRequestView;
  salesOrderId: string;
  canReview: boolean;
  currentUserId: string;
}) {
  const isActive = request.status === "REQUESTED" || request.status === "ON_HOLD";
  const isSelfReview = request.requestedById === currentUserId;
  const typeLabel = request.requestType === "CUSTOMER_CANCELLED" ? "PIC Membatalkan Pesanan" : "PIC Merasa Tidak Pernah Memesan";

  return (
    <div className="p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[request.status]}`}>
          {STATUS_LABEL[request.status]}
        </span>
        <span className="text-sm font-medium text-gray-900">{typeLabel}</span>
        {request.aiClassification && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-500">
            {request.aiClassification}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600 sm:grid-cols-3">
        <div><dt className="text-gray-400">PIC/Pelapor</dt><dd>{request.reportedPicName ?? "—"}</dd></div>
        <div><dt className="text-gray-400">Sumber Info</dt><dd>{CONTACT_SOURCE_LABEL[request.contactSource]}</dd></div>
        <div><dt className="text-gray-400">Alasan</dt><dd>{request.reasonCode.replace(/_/g, " ")}</dd></div>
        <div><dt className="text-gray-400">Tahap Order Saat Diajukan</dt><dd>{ORDER_STAGE_LABEL[request.orderStageAtRequest]}</dd></div>
        <div><dt className="text-gray-400">Diajukan Oleh</dt><dd>{request.requestedByName}</dd></div>
        <div><dt className="text-gray-400">Waktu Pengajuan</dt><dd>{formatDateTime(request.requestedAt)}</dd></div>
      </dl>

      {request.notes && (
        <p className="text-xs text-gray-600 italic">Catatan: {request.notes}</p>
      )}

      {!isActive && (
        <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 space-y-0.5">
          <p><span className="text-gray-400">Resolusi:</span> {request.resolution ? RESOLUTION_LABEL[request.resolution] : "—"}</p>
          {request.actualPicName && <p><span className="text-gray-400">PIC Sebenarnya:</span> {request.actualPicName}</p>}
          {request.resolutionNotes && <p><span className="text-gray-400">Catatan Review:</span> {request.resolutionNotes}</p>}
          {request.reviewedByName && (
            <p><span className="text-gray-400">Direview oleh:</span> {request.reviewedByName} · {request.reviewedAt ? formatDateTime(request.reviewedAt) : "—"}</p>
          )}
        </div>
      )}

      {isActive && canReview && !isSelfReview && (
        <ResolveForm requestId={request.id} salesOrderId={salesOrderId} requestType={request.requestType} />
      )}
      {isActive && canReview && isSelfReview && (
        <p className="text-xs text-amber-600">Anda mengajukan permintaan ini — menunggu review dari admin/owner/manager lain.</p>
      )}
      {isActive && !canReview && (
        <p className="text-xs text-gray-400">Menunggu review admin/owner/manager.</p>
      )}
    </div>
  );
}

function ResolveForm({
  requestId,
  salesOrderId,
  requestType,
}: {
  requestId: string;
  salesOrderId: string;
  requestType: "CUSTOMER_CANCELLED" | "CUSTOMER_DENIES_ORDER";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [actualPicName, setActualPicName] = useState("");
  const [pendingAction, setPendingAction] = useState<Resolution | null>(null);

  function submit(resolution: Resolution) {
    if (resolution === "ORDERED_BY_ANOTHER_PIC" && actualPicName.trim().length === 0) {
      setError("Nama PIC sebenarnya wajib diisi.");
      setPendingAction(resolution);
      return;
    }
    setError(null);
    setPendingAction(resolution);
    startTransition(async () => {
      const result = await resolveDisputeRequestAction(
        requestId,
        salesOrderId,
        resolution,
        notes.trim() || null,
        resolution === "ORDERED_BY_ANOTHER_PIC" ? actualPicName.trim() : null
      );
      if (!result.ok) {
        setError(result.error ?? "Gagal memproses review.");
        return;
      }
      router.refresh();
    });
  }

  const busy = (resolution: Resolution) => isPending && pendingAction === resolution;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50/50 p-3">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value.slice(0, 500))}
        disabled={isPending}
        placeholder="Catatan review (opsional)"
        rows={2}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
      />
      {requestType === "CUSTOMER_DENIES_ORDER" && (
        <input
          value={actualPicName}
          onChange={(e) => setActualPicName(e.target.value)}
          disabled={isPending}
          placeholder="Nama PIC sebenarnya (jika dipesan PIC lain)"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
        />
      )}
      <div className="flex flex-wrap gap-2">
        {requestType === "CUSTOMER_CANCELLED" && (
          <>
            <ActionButton
              label="Approve Pembatalan"
              icon={CheckCircle2}
              tone="green"
              busy={busy("CANCEL_APPROVED")}
              disabled={isPending}
              onClick={() => submit("CANCEL_APPROVED")}
            />
            <ActionButton
              label="Reject Pembatalan"
              icon={XCircle}
              tone="red"
              busy={busy("CANCEL_REJECTED")}
              disabled={isPending}
              onClick={() => submit("CANCEL_REJECTED")}
            />
          </>
        )}
        {requestType === "CUSTOMER_DENIES_ORDER" && (
          <>
            <ActionButton
              label="Konfirmasi Tidak Pernah Pesan"
              icon={UserX}
              tone="red"
              busy={busy("CANCELLED_NOT_ORDERED")}
              disabled={isPending}
              onClick={() => submit("CANCELLED_NOT_ORDERED")}
            />
            <ActionButton
              label="Konfirmasi Dipesan PIC Lain"
              icon={UserCheck}
              tone="green"
              busy={busy("ORDERED_BY_ANOTHER_PIC")}
              disabled={isPending}
              onClick={() => submit("ORDERED_BY_ANOTHER_PIC")}
            />
          </>
        )}
        <ActionButton
          label="Tetap Ditahan (Hold)"
          icon={PauseCircle}
          tone="gray"
          busy={busy("KEPT_ON_HOLD")}
          disabled={isPending}
          onClick={() => submit("KEPT_ON_HOLD")}
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const TONE_CLASS: Record<"green" | "red" | "gray", string> = {
  green: "bg-green-600 hover:bg-green-700 text-white",
  red: "bg-red-600 hover:bg-red-700 text-white",
  gray: "border border-gray-200 text-gray-600 hover:bg-gray-100",
};

function ActionButton({
  label,
  icon: Icon,
  tone,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof CheckCircle2;
  tone: "green" | "red" | "gray";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${TONE_CLASS[tone]}`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}
