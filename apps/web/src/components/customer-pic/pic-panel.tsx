"use client";

// =============================================================================
// PIC panel — daftar PIC toko + Human Review verifikasi. Purely additive di
// halaman detail customer, tidak mengubah bagian existing.
// =============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, AlertTriangle, History, Mail, Pencil } from "lucide-react";
import { verifyCustomerPicAction, updateCustomerPicAction } from "@/lib/customer-pic/actions";
import { PIC_ROLE_LABEL, PIC_VALIDATION_STATUS_LABEL, type PicRole, type PicValidationStatus, type AdminSettablePicStatus } from "@/lib/customer-pic/types";

export interface PicView {
  id: string;
  name: string;
  phone: string;
  /** Opsional -- tidak pernah jadi bukti verifikasi. */
  email: string | null;
  roles: PicRole[];
  validationStatus: PicValidationStatus;
  createdByName: string;
  createdById: string;
  createdAt: string;
  verifiedByName: string | null;
  verifiedAt: string | null;
}

export interface PicHistoryView {
  id: string;
  customerPicId: string;
  changeType: string;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  source: string;
  actorName: string;
  createdAt: string;
}

export interface RelationshipEventView {
  id: string;
  eventType: string;
  severity: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_BADGE: Record<PicValidationStatus, string> = {
  UNVERIFIED: "bg-amber-50 text-amber-700",
  VERIFIED_BY_ADMIN: "bg-green-50 text-green-700",
  VERIFIED_BY_ORDER: "bg-green-50 text-green-700",
  VERIFIED_ON_DELIVERY: "bg-green-50 text-green-700",
  REVERIFY_REQUIRED: "bg-orange-50 text-orange-700",
  INACTIVE: "bg-gray-100 text-gray-500",
};

export function PicPanel({
  customerId,
  pics,
  history,
  relationshipEvents,
  canVerify,
  currentUserId,
}: {
  customerId: string;
  pics: PicView[];
  history: PicHistoryView[];
  relationshipEvents: RelationshipEventView[];
  canVerify: boolean;
  currentUserId: string;
}) {
  const duplicateWarnings = relationshipEvents.filter(
    (e) => e.eventType === "DUPLICATE_STORE_DETECTED" || e.eventType === "DUPLICATE_PIC_DETECTED"
  );

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
        <ShieldCheck className="h-4 w-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-gray-900">PIC (Contact Person)</h2>
        <span className="ml-auto text-xs text-gray-400">{pics.length} PIC</span>
      </div>

      {duplicateWarnings.length > 0 && (
        <div className="mx-5 mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" />
            Duplicate Warning
          </div>
          {duplicateWarnings.map((e) => (
            <p key={e.id} className="text-xs text-amber-700">
              {e.eventType === "DUPLICATE_STORE_DETECTED" ? "Toko mirip terdeteksi saat pendaftaran (override)." : "Nomor PIC ini juga terdaftar di toko lain."}
              {" · "}
              {formatDateTime(e.createdAt)}
            </p>
          ))}
        </div>
      )}

      {pics.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-400">Belum ada PIC terdaftar.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {pics.map((pic) => (
            <PicCard
              key={pic.id}
              customerId={customerId}
              pic={pic}
              history={history.filter((h) => h.customerPicId === pic.id)}
              canVerify={canVerify}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PicCard({
  customerId,
  pic,
  history,
  canVerify,
  currentUserId,
}: {
  customerId: string;
  pic: PicView;
  history: PicHistoryView[];
  canVerify: boolean;
  currentUserId: string;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [showEditEmail, setShowEditEmail] = useState(false);
  const isSelfRegistered = pic.createdById === currentUserId;

  return (
    <div className="p-5 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900">{pic.name}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[pic.validationStatus]}`}>
              {PIC_VALIDATION_STATUS_LABEL[pic.validationStatus]}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{pic.phone}</p>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <Mail className="h-3 w-3 text-gray-400" />
            {pic.email ?? <span className="text-gray-400">Tidak ada email</span>}
            {canVerify && (
              <button onClick={() => setShowEditEmail((v) => !v)} className="text-gray-400 hover:text-blue-600">
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500">{pic.roles.map((r) => PIC_ROLE_LABEL[r]).join(", ")}</p>
        </div>
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
        >
          <History className="h-3.5 w-3.5" />
          Riwayat ({history.length})
        </button>
      </div>

      {showEditEmail && (
        <EditEmailForm customerId={customerId} customerPicId={pic.id} currentEmail={pic.email} onDone={() => setShowEditEmail(false)} />
      )}

      <p className="text-xs text-gray-400">
        Didaftarkan oleh {pic.createdByName} · {formatDateTime(pic.createdAt)}
        {pic.verifiedByName && (
          <> · Direview {pic.verifiedByName} · {pic.verifiedAt ? formatDateTime(pic.verifiedAt) : "—"}</>
        )}
      </p>

      {showHistory && (
        <div className="rounded-lg bg-gray-50 p-3 space-y-1.5">
          {history.length === 0 ? (
            <p className="text-xs text-gray-400">Belum ada perubahan.</p>
          ) : (
            history.map((h) => (
              <div key={h.id} className="text-xs text-gray-600">
                <span className="font-medium">{h.changeType}</span>
                {h.fieldName && <span> — {h.fieldName}: {h.oldValue ?? "-"} → {h.newValue ?? "-"}</span>}
                {h.reason && <span className="italic"> ({h.reason})</span>}
                <span className="text-gray-400"> · {h.actorName} · {formatDateTime(h.createdAt)}</span>
              </div>
            ))
          )}
        </div>
      )}

      {canVerify && pic.validationStatus !== "INACTIVE" && (
        isSelfRegistered ? (
          <p className="text-xs text-amber-600">Anda mendaftarkan PIC ini — menunggu review dari admin/owner/manager lain.</p>
        ) : (
          <VerifyForm customerId={customerId} customerPicId={pic.id} />
        )
      )}
    </div>
  );
}

function VerifyForm({ customerId, customerPicId }: { customerId: string; customerPicId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<AdminSettablePicStatus | null>(null);

  function submit(newStatus: AdminSettablePicStatus) {
    if (!reason.trim()) {
      setError("Alasan wajib diisi.");
      setPendingAction(newStatus);
      return;
    }
    setError(null);
    setPendingAction(newStatus);
    startTransition(async () => {
      const result = await verifyCustomerPicAction({ customerId, customerPicId, newStatus, reason: reason.trim() });
      if (!result.ok) {
        setError(result.error ?? "Gagal memproses.");
        return;
      }
      setReason("");
      router.refresh();
    });
  }

  const busy = (s: AdminSettablePicStatus) => isPending && pendingAction === s;

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50/50 p-3">
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 500))}
        disabled={isPending}
        placeholder="Alasan verifikasi/perubahan status (wajib)"
        rows={2}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => submit("VERIFIED_BY_ADMIN")}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {busy("VERIFIED_BY_ADMIN") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Verify
        </button>
        <button
          onClick={() => submit("REVERIFY_REQUIRED")}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg border border-orange-200 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-60"
        >
          {busy("REVERIFY_REQUIRED") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
          Perlu Verifikasi Ulang
        </button>
        <button
          onClick={() => submit("INACTIVE")}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
        >
          {busy("INACTIVE") ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldX className="h-3.5 w-3.5" />}
          Nonaktifkan
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function EditEmailForm({
  customerId,
  customerPicId,
  currentEmail,
  onDone,
}: {
  customerId: string;
  customerPicId: string;
  currentEmail: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(currentEmail ?? "");
  const [reason, setReason] = useState("");

  function submit() {
    if (!reason.trim()) {
      setError("Alasan wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateCustomerPicAction({
        customerId, customerPicId, newEmail: email.trim(), reason: reason.trim(),
      });
      if (!result.ok) {
        setError(result.error ?? "Gagal mengubah email.");
        return;
      }
      router.refresh();
      onDone();
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={isPending}
        placeholder="Email PIC (opsional)"
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
      />
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 500))}
        disabled={isPending}
        placeholder="Alasan perubahan email (wajib)"
        rows={2}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Simpan Email
        </button>
        <button
          onClick={onDone}
          disabled={isPending}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
        >
          Batal
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
