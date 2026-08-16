"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import type { SalesReportFormData } from "@/lib/sales-reports/actions";
import { getDailyReportPreviewAction } from "@/lib/sales-reports/actions";
import type { DailyGovernedKpiSummary, DailySoldItem } from "@/lib/sales-reports/queries";

interface SalesUser { id: string; full_name: string; }

interface SalesReportFormProps {
  salesUsers: SalesUser[];
  /** ID user login bila dia sales (laporan atas nama sendiri, tanpa selector) */
  selfSalespersonId: string | null;
  /** Ringkasan KPI + item terjual hari ini (default), sudah dihitung server saat halaman dimuat. */
  initialPreview: { kpi: DailyGovernedKpiSummary; items: DailySoldItem[] };
  action: (data: SalesReportFormData) => Promise<void>;
  cancelHref: string;
}

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const inputCls =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelCls = "mb-1 block text-sm font-medium text-gray-700";

export function SalesReportForm({
  salesUsers, selfSalespersonId, initialPreview, action, cancelHref,
}: SalesReportFormProps) {
  const [isPending, startTransition] = useTransition();
  const [isPreviewPending, startPreviewTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [reportDate, setReportDate]       = useState(todayISO());
  const [salespersonId, setSalespersonId] = useState(selfSalespersonId ?? "");
  const [area, setArea]                   = useState("");
  const [remainingDays, setRemainingDays] = useState(0);
  const [notes, setNotes]                 = useState("");
  const [preview, setPreview]             = useState(initialPreview);

  const isFirstRender = useRef(true);
  const effectiveSalespersonId = selfSalespersonId ?? salespersonId;

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!effectiveSalespersonId || !reportDate) return;
    startPreviewTransition(async () => {
      const result = await getDailyReportPreviewAction(effectiveSalespersonId, reportDate);
      setPreview(result);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportDate, effectiveSalespersonId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!reportDate) { setError("Tanggal laporan harus diisi"); return; }
    if (!selfSalespersonId && !salespersonId) { setError("Salesperson harus dipilih"); return; }

    const data: SalesReportFormData = {
      report_date: reportDate,
      salesperson_id: selfSalespersonId ?? salespersonId,
      area: area.trim() || null,
      remaining_working_days: remainingDays,
      notes: notes.trim() || null,
    };

    startTransition(async () => {
      try {
        await action(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  const totalItemValue = preview.items.reduce((s, i) => s + i.value, 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Info dasar */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Informasi Laporan</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls}>Tanggal Laporan <span className="text-red-500">*</span></label>
            <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)}
              max={todayISO()} className={inputCls} required />
          </div>
          {!selfSalespersonId && (
            <div>
              <label className={labelCls}>Salesperson <span className="text-red-500">*</span></label>
              <select value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)} className={inputCls} required>
                <option value="">— Pilih Sales —</option>
                {salesUsers.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls}>Area Kunjungan</label>
            <input type="text" value={area} onChange={(e) => setArea(e.target.value)}
              placeholder="Contoh: Cirebon Kota" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Sisa Hari Kerja Bulan Ini</label>
            <input type="number" min={0} value={remainingDays}
              onChange={(e) => setRemainingDays(Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
        </div>
      </div>

      {/* Ringkasan KPI otomatis dari sistem -- read-only, bukan input manual */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-gray-900">Ringkasan KPI Hari Ini (dari Sistem)</h2>
          {isPreviewPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
        </div>
        <p className="mb-4 text-xs text-gray-400">
          Dihitung otomatis dari data order/kunjungan sungguhan — sama persis
          dengan yang dilihat Owner. Tidak bisa diedit di sini.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-lg bg-gray-50 px-3 py-2.5">
            <p className="text-xs text-gray-500">Call</p>
            <p className="text-sm font-semibold text-gray-900">{preview.kpi.call}</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2.5">
            <p className="text-xs text-gray-500">Effective Call</p>
            <p className="text-sm font-semibold text-gray-900">{preview.kpi.effectiveCall}</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2.5">
            <p className="text-xs text-gray-500">Order</p>
            <p className="text-sm font-semibold text-gray-900">{preview.kpi.orderCount}</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2.5">
            <p className="text-xs text-gray-500">Omzet</p>
            <p className="text-sm font-semibold text-gray-900">{formatIDR(preview.kpi.revenue)}</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2.5">
            <p className="text-xs text-gray-500">Toko Baru (NOO)</p>
            <p className="text-sm font-semibold text-gray-900">{preview.kpi.noo}</p>
          </div>
        </div>
      </div>

      {/* Produk terjual -- otomatis dari sales order, bukan input manual */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold text-gray-900">Produk Terjual Hari Ini</h2>
        <p className="mb-4 text-xs text-gray-400">Otomatis dari sales order confirmed pada tanggal ini.</p>
        {preview.items.length === 0 ? (
          <p className="rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-400">
            Belum ada order confirmed pada tanggal ini.
          </p>
        ) : (
          <div className="space-y-2">
            {preview.items.map((item) => (
              <div key={item.product_id ?? item.product_name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
                <span className="font-medium text-gray-900">{item.product_name}</span>
                <span className="text-gray-500">{item.quantity} {item.unit}</span>
                <span className="font-medium text-gray-900">{formatIDR(item.value)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-sm">
              <span className="font-semibold text-gray-900">Total Nilai</span>
              <span className="font-semibold text-gray-900">{formatIDR(totalItemValue)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Catatan */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <label className={labelCls}>Catatan</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
          placeholder="Kendala di lapangan, follow-up yang dibutuhkan, dll." className={inputCls} />
      </div>

      {/* Submit */}
      <div className="flex items-center justify-end gap-3">
        <a href={cancelHref}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Batal
        </a>
        <button type="submit" disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Simpan Laporan
        </button>
      </div>
    </form>
  );
}
