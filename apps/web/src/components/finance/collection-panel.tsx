"use client";

// =============================================================================
// Gate 2I.2 -- Collection & Janji Bayar (kontrak §5.2). Satu client panel
// menangani seluruh aksi domain ini: catat aktivitas (record_collection_
// activity), buat/koreksi/batalkan janji bayar, tandai wanprestasi. Dialog
// konfirmasi generic (ConfirmDialog) dipakai untuk semua aksi yang mengubah
// status -- idempotency key di-generate SEKALI saat dialog dibuka (state
// komponen ini), bukan di-generate ulang tiap klik submit (kontrak §5).
// =============================================================================

import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import type {
  CollectionActivityListItem,
  OutstandingInvoiceOption,
  PromiseListItem,
} from "@/lib/finance/queries";
import {
  cancelPromiseToPayAction,
  correctPromiseToPayAction,
  createPromiseToPayAction,
  markPromiseBrokenAction,
  recordCollectionActivityAction,
} from "@/lib/finance/actions";

const CHANNEL_OPTIONS = [
  { value: "phone", label: "Telepon" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "visit", label: "Kunjungan" },
  { value: "other", label: "Lainnya" },
] as const;

const OUTCOME_OPTIONS = [
  { value: "contacted_successfully", label: "Berhasil dihubungi" },
  { value: "not_contactable", label: "Tidak dapat dihubungi" },
  { value: "not_paid_yet", label: "Belum bayar" },
  { value: "dispute", label: "Sanggahan/dispute" },
  { value: "claimed_paid_partial", label: "Klaim bayar sebagian" },
  { value: "claimed_paid_full", label: "Klaim bayar lunas" },
];

const OUTCOME_LABEL_MAP = Object.fromEntries(OUTCOME_OPTIONS.map((o) => [o.value, o.label]));
const CHANNEL_LABEL_MAP = Object.fromEntries(CHANNEL_OPTIONS.map((o) => [o.value, o.label]));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type DialogState =
  | { type: "create" }
  | { type: "correct"; promise: PromiseListItem }
  | { type: "cancel"; promise: PromiseListItem }
  | { type: "broken"; promise: PromiseListItem }
  | { type: "activity" }
  | null;

interface CollectionPanelProps {
  promises: PromiseListItem[];
  activities: CollectionActivityListItem[];
  outstandingInvoices: OutstandingInvoiceOption[];
  canRecord: boolean;
  canPromise: boolean;
}

export function CollectionPanel({ promises, activities, outstandingInvoices, canRecord, canPromise }: CollectionPanelProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openDialog(next: DialogState) {
    setError(null);
    setIdempotencyKey(crypto.randomUUID());
    setDialog(next);
  }
  function closeDialog() {
    if (isPending) return;
    setDialog(null);
    setError(null);
  }

  // ---- Create promise ----
  const [createInvoiceId, setCreateInvoiceId] = useState("");
  const [createAmount, setCreateAmount] = useState("");
  const [createDate, setCreateDate] = useState(todayIso());
  const [createChannel, setCreateChannel] = useState<(typeof CHANNEL_OPTIONS)[number]["value"]>("phone");

  function submitCreate() {
    const invoice = outstandingInvoices.find((i) => i.id === createInvoiceId);
    if (!invoice) {
      setError("Pilih invoice terlebih dahulu.");
      return;
    }
    const amount = Number(createAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Nominal janji bayar harus lebih besar dari nol.");
      return;
    }
    if (amount > invoice.outstandingBalance) {
      setError("Nominal melebihi sisa piutang invoice ini.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await createPromiseToPayAction({
          invoiceId: invoice.id,
          promisedAmount: amount,
          promisedDate: createDate,
          channel: createChannel,
          idempotencyKey,
        });
        setDialog(null);
        setCreateInvoiceId("");
        setCreateAmount("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  // ---- Correct promise ----
  const [correctAmount, setCorrectAmount] = useState("");
  const [correctDate, setCorrectDate] = useState("");
  const [correctReason, setCorrectReason] = useState("");

  function openCorrect(promise: PromiseListItem) {
    setCorrectAmount(String(promise.promisedAmount));
    setCorrectDate(promise.promisedDate);
    setCorrectReason("");
    openDialog({ type: "correct", promise });
  }

  function submitCorrect() {
    if (dialog?.type !== "correct") return;
    const amount = Number(correctAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Nominal janji bayar harus lebih besar dari nol.");
      return;
    }
    if (!correctReason.trim()) {
      setError("Alasan koreksi wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await correctPromiseToPayAction({
          promiseId: dialog.promise.id,
          newPromisedAmount: amount,
          newPromisedDate: correctDate,
          reason: correctReason.trim(),
          idempotencyKey,
        });
        setDialog(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  // ---- Cancel promise ----
  const [cancelReason, setCancelReason] = useState("");

  function submitCancel() {
    if (dialog?.type !== "cancel") return;
    if (!cancelReason.trim()) {
      setError("Alasan pembatalan wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await cancelPromiseToPayAction({ promiseId: dialog.promise.id, reason: cancelReason.trim(), idempotencyKey });
        setDialog(null);
        setCancelReason("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  // ---- Mark broken ----
  function submitBroken() {
    if (dialog?.type !== "broken") return;
    setError(null);
    startTransition(async () => {
      try {
        await markPromiseBrokenAction({ promiseId: dialog.promise.id, idempotencyKey });
        setDialog(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  // ---- Record activity ----
  const [activityInvoiceId, setActivityInvoiceId] = useState("");
  const [activityChannel, setActivityChannel] = useState<(typeof CHANNEL_OPTIONS)[number]["value"]>("phone");
  const [activityType, setActivityType] = useState<"attempt" | "outcome">("attempt");
  const [activityOutcome, setActivityOutcome] = useState<string>("contacted_successfully");
  const [activityReportedAmount, setActivityReportedAmount] = useState("");
  const [activityNote, setActivityNote] = useState("");

  function submitActivity() {
    if (!activityInvoiceId) {
      setError("Pilih invoice terlebih dahulu.");
      return;
    }
    const isClaim = activityOutcome === "claimed_paid_partial" || activityOutcome === "claimed_paid_full";
    setError(null);
    startTransition(async () => {
      try {
        await recordCollectionActivityAction({
          invoiceId: activityInvoiceId,
          channel: activityChannel,
          activityType,
          outcome: activityType === "outcome" ? activityOutcome : null,
          reportedAmount: activityType === "outcome" && isClaim && activityReportedAmount ? Number(activityReportedAmount) : null,
          note: activityNote.trim() || null,
          idempotencyKey,
        });
        setDialog(null);
        setActivityInvoiceId("");
        setActivityReportedAmount("");
        setActivityNote("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  const promiseColumns: Column<PromiseListItem>[] = [
    { key: "invoiceNumber", label: "Invoice", render: (row) => <span className="font-mono text-xs">{row.invoiceNumber}</span> },
    { key: "customerName", label: "Customer" },
    { key: "promisedAmount", label: "Nominal", align: "right", render: (row) => formatRupiah(row.promisedAmount) },
    { key: "promisedDate", label: "Tgl. Janji", render: (row) => formatJakartaDateTime(row.promisedDate) },
    { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} domain="promise" /> },
    {
      key: "actions",
      label: "Aksi",
      align: "right",
      render: (row) => {
        if (row.status !== "open") return <span className="text-xs text-gray-300">—</span>;
        if (!canPromise) {
          return (
            <span title="Bukan kewenangan Anda" className="text-xs text-gray-300">
              Tidak tersedia
            </span>
          );
        }
        const isDue = new Date(row.promisedDate) <= new Date();
        return (
          <div className="flex justify-end gap-2">
            {isDue && (
              <button
                type="button"
                onClick={() => openDialog({ type: "broken", promise: row })}
                className="text-xs font-medium text-red-600 hover:underline"
              >
                Tandai Wanprestasi
              </button>
            )}
            <button type="button" onClick={() => openCorrect(row)} className="text-xs font-medium text-blue-600 hover:underline">
              Koreksi
            </button>
            <button
              type="button"
              onClick={() => openDialog({ type: "cancel", promise: row })}
              className="text-xs font-medium text-gray-500 hover:underline"
            >
              Batalkan
            </button>
          </div>
        );
      },
    },
  ];

  const activityColumns: Column<CollectionActivityListItem>[] = [
    { key: "occurredAt", label: "Waktu", render: (row) => formatJakartaDateTime(row.occurredAt) },
    { key: "invoiceNumber", label: "Invoice", render: (row) => <span className="font-mono text-xs">{row.invoiceNumber}</span> },
    { key: "customerName", label: "Customer" },
    { key: "channel", label: "Kanal", render: (row) => CHANNEL_LABEL_MAP[row.channel] ?? row.channel },
    {
      key: "outcome",
      label: "Hasil",
      render: (row) =>
        row.activityType === "attempt" ? (
          <span className="text-xs text-gray-500">Percobaan hubungi</span>
        ) : (
          <span className="text-xs text-gray-700">{OUTCOME_LABEL_MAP[row.outcome ?? ""] ?? row.outcome}</span>
        ),
    },
    {
      key: "reportedAmount",
      label: "Nominal Klaim",
      align: "right",
      render: (row) => (row.reportedAmount != null ? formatRupiah(row.reportedAmount) : "—"),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <SectionHeader title="Janji Bayar" description="Janji bayar aktif dan riwayat koreksi/pembatalan/wanprestasi.">
          {canPromise && (
            <button
              type="button"
              onClick={() => openDialog({ type: "create" })}
              disabled={outstandingInvoices.filter((i) => !i.hasOpenPromise).length === 0}
              title={
                outstandingInvoices.filter((i) => !i.hasOpenPromise).length === 0
                  ? "Tidak ada invoice yang memenuhi syarat untuk janji bayar baru"
                  : undefined
              }
              className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Janji Bayar Baru
            </button>
          )}
        </SectionHeader>
        <div className="rounded-xl border border-gray-200 bg-white">
          {promises.length === 0 ? (
            <EmptyState title="Belum ada janji bayar" description="Janji bayar akan muncul di sini setelah dibuat." />
          ) : (
            <DataTable<PromiseListItem> columns={promiseColumns} data={promises} keyExtractor={(row) => row.id} />
          )}
        </div>
      </div>

      <div>
        <SectionHeader title="Riwayat Aktivitas Collection" description="Percobaan hubungi dan klaim bayar dari customer.">
          {canRecord && (
            <button
              type="button"
              onClick={() => openDialog({ type: "activity" })}
              disabled={outstandingInvoices.length === 0}
              className="rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Catat Aktivitas
            </button>
          )}
        </SectionHeader>
        <div className="rounded-xl border border-gray-200 bg-white">
          {activities.length === 0 ? (
            <EmptyState title="Belum ada aktivitas collection" />
          ) : (
            <DataTable<CollectionActivityListItem> columns={activityColumns} data={activities} keyExtractor={(row) => row.id} compact />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={dialog?.type === "create"}
        title="Buat Janji Bayar Baru"
        confirmLabel="Buat Janji Bayar"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitCreate}
        onCancel={closeDialog}
      >
        <div className="space-y-3 text-left">
          <label className="block text-xs font-medium text-gray-600">
            Invoice
            <select
              value={createInvoiceId}
              onChange={(e) => setCreateInvoiceId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              <option value="">Pilih invoice…</option>
              {outstandingInvoices
                .filter((i) => !i.hasOpenPromise)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoiceNumber} — {i.customerName} ({formatRupiah(i.outstandingBalance)})
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Nominal Janji
            <input
              type="number"
              min={1}
              value={createAmount}
              onChange={(e) => setCreateAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Tanggal Janji
            <input
              type="date"
              min={todayIso()}
              value={createDate}
              onChange={(e) => setCreateDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Kanal
            <select
              value={createChannel}
              onChange={(e) => setCreateChannel(e.target.value as typeof createChannel)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.type === "correct"}
        title="Koreksi Janji Bayar"
        description="Koreksi menutup janji lama dan membuat versi baru -- riwayat lama tetap tersimpan."
        confirmLabel="Simpan Koreksi"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitCorrect}
        onCancel={closeDialog}
      >
        <div className="space-y-3 text-left">
          <label className="block text-xs font-medium text-gray-600">
            Nominal Baru
            <input
              type="number"
              min={1}
              value={correctAmount}
              onChange={(e) => setCorrectAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Tanggal Baru
            <input
              type="date"
              value={correctDate}
              onChange={(e) => setCorrectDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Alasan
            <textarea
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
              rows={2}
            />
          </label>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.type === "cancel"}
        title="Batalkan Janji Bayar"
        danger
        confirmLabel="Batalkan Janji"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitCancel}
        onCancel={closeDialog}
      >
        <label className="block text-left text-xs font-medium text-gray-600">
          Alasan
          <textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            rows={2}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.type === "broken"}
        title="Tandai Wanprestasi"
        description="Janji bayar ini sudah melewati tanggal jatuh tempo dan belum diselesaikan."
        danger
        confirmLabel="Tandai Wanprestasi"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitBroken}
        onCancel={closeDialog}
      />

      <ConfirmDialog
        open={dialog?.type === "activity"}
        title="Catat Aktivitas Collection"
        confirmLabel="Simpan Aktivitas"
        isSubmitting={isPending}
        error={error}
        onConfirm={submitActivity}
        onCancel={closeDialog}
      >
        <div className="space-y-3 text-left">
          <label className="block text-xs font-medium text-gray-600">
            Invoice
            <select
              value={activityInvoiceId}
              onChange={(e) => setActivityInvoiceId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              <option value="">Pilih invoice…</option>
              {outstandingInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoiceNumber} — {i.customerName}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Kanal
            <select
              value={activityChannel}
              onChange={(e) => setActivityChannel(e.target.value as typeof activityChannel)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Jenis
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value as "attempt" | "outcome")}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
            >
              <option value="attempt">Percobaan hubungi (belum ada hasil)</option>
              <option value="outcome">Hasil</option>
            </select>
          </label>
          {activityType === "outcome" && (
            <>
              <label className="block text-xs font-medium text-gray-600">
                Hasil
                <select
                  value={activityOutcome}
                  onChange={(e) => setActivityOutcome(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                >
                  {OUTCOME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {(activityOutcome === "claimed_paid_partial" || activityOutcome === "claimed_paid_full") && (
                <label className="block text-xs font-medium text-gray-600">
                  Nominal Klaim Customer
                  <input
                    type="number"
                    min={1}
                    value={activityReportedAmount}
                    onChange={(e) => setActivityReportedAmount(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                  />
                  <span className="mt-1 block text-[11px] font-normal text-gray-400">
                    Ini hanya klaim lisan customer -- tidak mengubah ledger/outstanding. Pembayaran nyata dicatat lewat
                    tab Pembayaran &amp; Verifikasi.
                  </span>
                </label>
              )}
            </>
          )}
          <label className="block text-xs font-medium text-gray-600">
            Catatan (opsional)
            <textarea
              value={activityNote}
              onChange={(e) => setActivityNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
              rows={2}
            />
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}
