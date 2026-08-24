"use client";

import { useRef, useState, useTransition } from "react";
import { AlertCircle, CheckCircle2, Loader2, MapPin } from "lucide-react";
import {
  completeSalesVisitAction,
  startSalesVisitAction,
} from "@/lib/sales-visits/actions";
import {
  recordCollectionFieldOutcomeAction,
  type CollectionFieldOutcome,
} from "@/lib/finance/actions";
import type { OutstandingInvoiceOption } from "@/lib/finance/queries";
import { formatRupiah } from "@/lib/document-engine/monetary";
import {
  VISIT_ACTIVITIES,
  VISIT_MET_WITH_OPTIONS,
  VISIT_PURPOSES,
  VISIT_RESULTS,
  type SalesVisit,
  type VisitActivity,
  type VisitMetWith,
  type VisitPurpose,
  type VisitResult,
} from "@/lib/sales-visits/types";
import {
  VISIT_ACTIVITY_LABELS,
  VISIT_MET_WITH_LABELS,
  VISIT_PURPOSE_LABELS,
  VISIT_RESULT_LABELS,
} from "./labels";

// Gate P4.21 -- outcome non-pembayaran yang boleh ditulis actor field-tier
// (collection.record.field), dikecualikan not_contactable karena kontradiktif
// dengan konteks di sini (form ini hanya muncul saat visitResult=MET_STORE).
const COLLECTION_OUTCOME_OPTIONS: { value: CollectionFieldOutcome; label: string }[] = [
  { value: "not_paid_yet", label: "Belum bisa bayar" },
  { value: "dispute", label: "Ada keberatan/sengketa jumlah" },
  { value: "contacted_successfully", label: "Bertemu, tidak ada kendala penagihan" },
];

interface CustomerOption {
  id: string;
  name: string;
  address: string | null;
}

interface SalesVisitWorkspaceProps {
  customers: CustomerOption[];
  initialActiveVisit: SalesVisit | null;
  initialHistory: SalesVisit[];
  outstandingInvoices: OutstandingInvoiceOption[];
}

interface GeoPoint {
  latitude: number;
  longitude: number;
}

function getCurrentPosition(): Promise<GeoPoint> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation tidak didukung browser ini."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () =>
        reject(
          new Error(
            "Gagal mengambil lokasi. Aktifkan izin lokasi browser lalu coba lagi.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

const inputCls =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelCls = "block text-xs font-medium text-gray-700 mb-1";
const section = "rounded-xl border bg-white p-5 shadow-sm space-y-4";

function StatusBadge({ label, tone }: { label: string; tone: "green" | "gray" | "amber" }) {
  const toneCls =
    tone === "green"
      ? "bg-green-50 text-green-700 border-green-200"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-gray-50 text-gray-500 border-gray-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneCls}`}>
      {label}
    </span>
  );
}

function VisitHistoryRow({ visit, customerName }: { visit: SalesVisit; customerName: string }) {
  return (
    <div className="rounded-lg border border-gray-100 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-gray-900">{customerName}</p>
          <p className="text-xs text-gray-400">
            {new Date(visit.startedAt).toLocaleString("id-ID")}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {visit.status === "IN_PROGRESS" ? (
            <StatusBadge label="Sedang berjalan" tone="amber" />
          ) : (
            <>
              <StatusBadge
                label={visit.callId ? "CALL +1" : "CALL 0"}
                tone={visit.callId ? "green" : "gray"}
              />
              <StatusBadge
                label={visit.isEffective ? "EC +1" : "EC 0"}
                tone={visit.isEffective ? "green" : "gray"}
              />
            </>
          )}
        </div>
      </div>
      {visit.status === "COMPLETED" && visit.visitResult && (
        <p className="mt-1.5 text-xs text-gray-500">
          {VISIT_RESULT_LABELS[visit.visitResult]}
          {visit.resultNotes ? ` — ${visit.resultNotes}` : ""}
        </p>
      )}
    </div>
  );
}

export function SalesVisitWorkspace({
  customers,
  initialActiveVisit,
  initialHistory,
  outstandingInvoices,
}: SalesVisitWorkspaceProps) {
  const [isPending, startTransition] = useTransition();
  // Tidak dikelola sebagai state lokal -- setiap mutasi sukses memicu
  // window.location.reload() untuk mengambil ulang data server terbaru,
  // jadi tidak pernah ada update optimistik yang perlu disinkronkan di sini.
  const activeVisit = initialActiveVisit;
  const history = initialHistory;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  // Start form state
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [visitPurpose, setVisitPurpose] = useState<VisitPurpose | "">("");
  const [planNotes, setPlanNotes] = useState("");

  // Complete form state
  const [visitResult, setVisitResult] = useState<VisitResult | "">("");
  const [metWith, setMetWith] = useState<VisitMetWith | "">("");
  const [metPersonName, setMetPersonName] = useState("");
  const [activities, setActivities] = useState<VisitActivity[]>([]);
  const [resultNotes, setResultNotes] = useState("");
  const [followUpNeeded, setFollowUpNeeded] = useState(false);
  const [followUpPlan, setFollowUpPlan] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");

  // Gate P4.21 -- follow-up "Catat Hasil Penagihan" (opsional), muncul hanya
  // saat kunjungan bertujuan Penagihan DAN berhasil ketemu toko.
  const [collectionInvoiceId, setCollectionInvoiceId] = useState("");
  const [collectionOutcome, setCollectionOutcome] = useState<CollectionFieldOutcome>("not_paid_yet");

  // Idempotency key dibuat sekali per percobaan submit (bukan per klik) --
  // retry request yang sama (double-click, koneksi putus lalu klik ulang)
  // mengirim key yang SAMA sehingga RPC mengembalikan hasil idempotent yang
  // identik (already_started/already_recorded), bukan sekadar ditolak.
  // startKeyRef fresh tiap mount (window.location.reload() setelah sukses
  // secara alami me-reset-nya). completeKey dipakai dari activeVisit.id
  // sendiri -- sudah unik per kunjungan, tidak perlu ref terpisah.
  const startKeyRef = useRef<string | null>(null);
  if (startKeyRef.current === null) {
    startKeyRef.current = crypto.randomUUID();
  }

  const filteredCustomers = (() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.address && c.address.toLowerCase().includes(q)),
    );
  })();

  function resetCompleteForm() {
    setVisitResult("");
    setMetWith("");
    setMetPersonName("");
    setActivities([]);
    setResultNotes("");
    setFollowUpNeeded(false);
    setFollowUpPlan("");
    setFollowUpDate("");
    setCollectionInvoiceId("");
    setCollectionOutcome("not_paid_yet");
  }

  const showCollectionFollowUp =
    activeVisit?.visitPurpose === "COLLECTION" && visitResult === "MET_STORE";
  const collectionInvoices = activeVisit
    ? outstandingInvoices.filter((i) => i.customerId === activeVisit.customerId)
    : [];

  function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!customerId) {
      setError("Toko/Pelanggan harus dipilih");
      return;
    }
    if (!visitPurpose) {
      setError("Tujuan kunjungan harus dipilih");
      return;
    }

    startTransition(async () => {
      setLocating(true);
      let point: GeoPoint;
      try {
        point = await getCurrentPosition();
      } catch (err) {
        setLocating(false);
        setError(err instanceof Error ? err.message : "Gagal mengambil lokasi.");
        return;
      }
      setLocating(false);

      const result = await startSalesVisitAction({
        customerId,
        visitPurpose,
        planNotes,
        startLatitude: point.latitude,
        startLongitude: point.longitude,
        idempotencyKey: startKeyRef.current!,
      });
      if (!result.ok) {
        setError(result.error ?? "Gagal memulai kunjungan.");
        return;
      }
      setNotice("Kunjungan dimulai.");
      setCustomerId("");
      setCustomerSearch("");
      setVisitPurpose("");
      setPlanNotes("");
      window.location.reload();
    });
  }

  function toggleActivity(value: VisitActivity) {
    setActivities((prev) =>
      prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value],
    );
  }

  function handleComplete(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!activeVisit) return;
    if (!visitResult) {
      setError("Hasil kunjungan harus dipilih");
      return;
    }
    if (visitResult === "MET_STORE" && !metWith) {
      setError("Pihak yang ditemui wajib diisi");
      return;
    }
    if (resultNotes.trim().length < 3) {
      setError("Catatan hasil wajib diisi (minimal 3 karakter)");
      return;
    }
    if (followUpNeeded && (followUpPlan.trim().length < 3 || !followUpDate)) {
      setError("Rencana dan tanggal tindak lanjut wajib diisi");
      return;
    }

    startTransition(async () => {
      setLocating(true);
      let point: GeoPoint;
      try {
        point = await getCurrentPosition();
      } catch (err) {
        setLocating(false);
        setError(err instanceof Error ? err.message : "Gagal mengambil lokasi.");
        return;
      }
      setLocating(false);

      const result = await completeSalesVisitAction({
        visitId: activeVisit.id,
        visitResult,
        metWith: visitResult === "MET_STORE" ? metWith || null : null,
        metPersonName,
        activities,
        resultNotes,
        followUpNeeded,
        followUpPlan,
        followUpDate,
        photoUrl: "",
        endLatitude: point.latitude,
        endLongitude: point.longitude,
        idempotencyKey: activeVisit.id,
      });
      if (!result.ok) {
        setError(result.error ?? "Gagal menyelesaikan kunjungan.");
        return;
      }
      let badge =
        result.outcome === "completed_cancelled"
          ? "Kunjungan dibatalkan tercatat, tidak ada achievement."
          : result.outcome === "completed_no_active_period"
            ? "Kunjungan tercatat, namun tidak ada periode KPI aktif sehingga achievement tidak dikreditkan."
            : `Kunjungan selesai. CALL ${result.callCredited ? "+1" : "0"}, Effective Call ${result.ecCredited ? "+1" : "0"}.`;

      // Gate P4.21 -- kunjungan sudah tercatat sukses di atas; hasil penagihan
      // adalah tambahan opsional, kegagalannya TIDAK membatalkan/mengulang
      // pencatatan kunjungan yang sudah sukses -- cukup ditambahkan sebagai
      // catatan di badge yang sama.
      if (showCollectionFollowUp && collectionInvoiceId) {
        try {
          await recordCollectionFieldOutcomeAction({
            invoiceId: collectionInvoiceId,
            outcome: collectionOutcome,
            note: resultNotes.trim() || null,
            idempotencyKey: crypto.randomUUID(),
          });
          badge += " Hasil penagihan tercatat.";
        } catch (err) {
          badge += ` Namun gagal mencatat hasil penagihan: ${err instanceof Error ? err.message : "terjadi kesalahan"}.`;
        }
      }

      setNotice(badge);
      resetCompleteForm();
      window.location.reload();
    });
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {notice}
        </div>
      )}

      {activeVisit ? (
        <div className={section}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Kunjungan Sedang Berjalan</h2>
            <StatusBadge label="IN PROGRESS" tone="amber" />
          </div>
          <p className="text-sm text-gray-600">
            {customers.find((c) => c.id === activeVisit.customerId)?.name ?? "Toko"} —{" "}
            {VISIT_PURPOSE_LABELS[activeVisit.visitPurpose]}
          </p>
          <p className="text-xs text-gray-400">
            Dimulai {new Date(activeVisit.startedAt).toLocaleString("id-ID")}
          </p>

          <form onSubmit={handleComplete} className="space-y-4 border-t border-gray-100 pt-4">
            <h3 className="text-sm font-semibold text-gray-900">Selesaikan Kunjungan</h3>
            <div>
              <label className={labelCls}>Hasil kunjungan <span className="text-red-500">*</span></label>
              <select
                value={visitResult}
                onChange={(e) => setVisitResult(e.target.value as VisitResult)}
                className={inputCls}
              >
                <option value="">— Pilih hasil —</option>
                {VISIT_RESULTS.map((r) => (
                  <option key={r} value={r}>{VISIT_RESULT_LABELS[r]}</option>
                ))}
              </select>
            </div>

            {visitResult === "MET_STORE" && (
              <>
                <div>
                  <label className={labelCls}>Bertemu dengan <span className="text-red-500">*</span></label>
                  <select
                    value={metWith}
                    onChange={(e) => setMetWith(e.target.value as VisitMetWith)}
                    className={inputCls}
                  >
                    <option value="">— Pilih —</option>
                    {VISIT_MET_WITH_OPTIONS.map((m) => (
                      <option key={m} value={m}>{VISIT_MET_WITH_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Nama orang yang ditemui</label>
                  <input
                    type="text"
                    value={metPersonName}
                    onChange={(e) => setMetPersonName(e.target.value)}
                    className={inputCls}
                    placeholder="Opsional"
                  />
                </div>
                <div>
                  <label className={labelCls}>Aktivitas yang dilakukan (mempengaruhi Effective Call)</label>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {VISIT_ACTIVITIES.map((a) => (
                      <label key={a} className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={activities.includes(a)}
                          onChange={() => toggleActivity(a)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        {VISIT_ACTIVITY_LABELS[a]}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {showCollectionFollowUp && (
              <div className="space-y-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Catat Hasil Penagihan</p>
                  <p className="text-xs text-gray-500">
                    Opsional -- kalau diisi, langsung tercatat sebagai hasil kunjungan penagihan (tidak perlu buka menu Klaim Pembayaran lagi).
                  </p>
                </div>
                {collectionInvoices.length === 0 ? (
                  <p className="text-xs text-gray-400">Toko ini tidak punya invoice outstanding.</p>
                ) : (
                  <>
                    <div>
                      <label className={labelCls}>Tagihan yang Dikunjungi</label>
                      <select
                        value={collectionInvoiceId}
                        onChange={(e) => setCollectionInvoiceId(e.target.value)}
                        className={inputCls}
                      >
                        <option value="">— Lewati, jangan catat hasil penagihan —</option>
                        {collectionInvoices.map((inv) => (
                          <option key={inv.id} value={inv.id}>
                            {inv.invoiceNumber} — {formatRupiah(inv.outstandingBalance)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {collectionInvoiceId && (
                      <div>
                        <label className={labelCls}>Hasil Penagihan</label>
                        <div className="space-y-1.5">
                          {COLLECTION_OUTCOME_OPTIONS.map((opt) => (
                            <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700">
                              <input
                                type="radio"
                                name="collection-outcome"
                                checked={collectionOutcome === opt.value}
                                onChange={() => setCollectionOutcome(opt.value)}
                              />
                              {opt.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <div>
              <label className={labelCls}>Catatan hasil <span className="text-red-500">*</span></label>
              <textarea
                value={resultNotes}
                onChange={(e) => setResultNotes(e.target.value)}
                className={inputCls}
                rows={3}
                placeholder="Minimal 3 karakter"
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={followUpNeeded}
                onChange={(e) => setFollowUpNeeded(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Perlu tindak lanjut
            </label>

            {followUpNeeded && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>Rencana tindak lanjut <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={followUpPlan}
                    onChange={(e) => setFollowUpPlan(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Tanggal tindak lanjut <span className="text-red-500">*</span></label>
                  <input
                    type="date"
                    value={followUpDate}
                    onChange={(e) => setFollowUpDate(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {locating ? "Mengambil lokasi..." : "Selesaikan Kunjungan"}
            </button>
          </form>
        </div>
      ) : (
        <form onSubmit={handleStart} className={section}>
          <h2 className="text-sm font-semibold text-gray-900">Mulai Kunjungan</h2>

          <div>
            <label className={labelCls}>Toko/Pelanggan <span className="text-red-500">*</span></label>
            <div className="space-y-1.5">
              <input
                type="text"
                placeholder="Cari nama atau alamat toko..."
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className={inputCls}
              />
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className={inputCls}
                size={customerSearch ? Math.min(filteredCustomers.length + 1, 6) : 1}
              >
                <option value="">— Pilih Toko —</option>
                {filteredCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.address ? ` — ${c.address}` : ""}
                  </option>
                ))}
              </select>
              {customerSearch.trim() && (
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <MapPin className="h-3 w-3" /> {filteredCustomers.length} toko ditemukan
                </p>
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>Tujuan Kunjungan <span className="text-red-500">*</span></label>
            <select
              value={visitPurpose}
              onChange={(e) => setVisitPurpose(e.target.value as VisitPurpose)}
              className={inputCls}
            >
              <option value="">— Pilih tujuan —</option>
              {VISIT_PURPOSES.map((p) => (
                <option key={p} value={p}>{VISIT_PURPOSE_LABELS[p]}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>Catatan rencana</label>
            <textarea
              value={planNotes}
              onChange={(e) => setPlanNotes(e.target.value)}
              className={inputCls}
              rows={2}
              placeholder="Opsional"
            />
          </div>

          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {locating ? "Mengambil lokasi..." : "Mulai Kunjungan"}
          </button>
        </form>
      )}

      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Riwayat Kunjungan</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-400">Belum ada kunjungan tercatat.</p>
        ) : (
          <div className="space-y-2">
            {history.map((visit) => (
              <VisitHistoryRow
                key={visit.id}
                visit={visit}
                customerName={
                  customers.find((c) => c.id === visit.customerId)?.name ?? "Toko"
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
