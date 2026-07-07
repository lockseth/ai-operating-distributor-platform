"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Plus, Trash2, Loader2 } from "lucide-react";
import type { SalesReportFormData, SalesReportItemInput } from "@/lib/sales-reports/actions";
import { calcGap, calcAchievementPct } from "@/lib/sales-reports/summary";

interface Product   { id: string; name: string; unit: string; }
interface SalesUser { id: string; full_name: string; }

interface SalesReportFormProps {
  products: Product[];
  salesUsers: SalesUser[];
  /** ID user login bila dia sales (laporan atas nama sendiri, tanpa selector) */
  selfSalespersonId: string | null;
  action: (data: SalesReportFormData) => Promise<void>;
  cancelHref: string;
}

interface ItemRow {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  value: number;
}

function emptyItem(): ItemRow {
  return { product_id: "", product_name: "", quantity: 0, unit: "pcs", value: 0 };
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
  products, salesUsers, selfSalespersonId, action, cancelHref,
}: SalesReportFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [reportDate, setReportDate]           = useState(todayISO());
  const [salespersonId, setSalespersonId]     = useState(selfSalespersonId ?? "");
  const [area, setArea]                       = useState("");
  const [targetOa, setTargetOa]               = useState(0);
  const [achievedOa, setAchievedOa]           = useState(0);
  const [targetRevenue, setTargetRevenue]     = useState(0);
  const [achievedRevenue, setAchievedRevenue] = useState(0);
  const [remainingDays, setRemainingDays]     = useState(0);
  const [discount, setDiscount]               = useState(0);
  const [notes, setNotes]                     = useState("");
  const [items, setItems]                     = useState<ItemRow[]>([emptyItem()]);

  function updateItem(idx: number, patch: Partial<ItemRow>) {
    setItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function selectProduct(idx: number, productId: string) {
    const p = products.find((pr) => pr.id === productId);
    if (p) {
      updateItem(idx, { product_id: p.id, product_name: p.name, unit: p.unit });
    } else {
      updateItem(idx, { product_id: "" });
    }
  }

  const totalValue      = items.reduce((s, i) => s + (i.value || 0), 0);
  const clampedDiscount = Math.min(discount, totalValue);
  const grandTotal      = totalValue - clampedDiscount;
  const gapRevenue      = calcGap(targetRevenue, achievedRevenue);
  const pctRevenue      = calcAchievementPct(targetRevenue, achievedRevenue);
  const pctOa           = calcAchievementPct(targetOa, achievedOa);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!reportDate) { setError("Tanggal laporan harus diisi"); return; }
    if (!selfSalespersonId && !salespersonId) { setError("Salesperson harus dipilih"); return; }

    const data: SalesReportFormData = {
      report_date: reportDate,
      salesperson_id: selfSalespersonId ?? salespersonId,
      area: area.trim() || null,
      target_oa: targetOa,
      achieved_oa: achievedOa,
      target_revenue: targetRevenue,
      achieved_revenue: achievedRevenue,
      remaining_working_days: remainingDays,
      discount_amount: clampedDiscount,
      notes: notes.trim() || null,
      items: items
        .filter((i) => i.product_name.trim() && i.quantity > 0)
        .map((i): SalesReportItemInput => ({
          product_id: i.product_id || null,
          product_name: i.product_name,
          quantity: i.quantity,
          unit: i.unit,
          value: i.value,
        })),
    };

    startTransition(async () => {
      try {
        await action(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

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

      {/* Target vs pencapaian */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Target &amp; Pencapaian</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Target OA (Outlet Aktif)</label>
            <input type="number" min={0} value={targetOa}
              onChange={(e) => setTargetOa(Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>OA Tercapai</label>
            <input type="number" min={0} value={achievedOa}
              onChange={(e) => setAchievedOa(Math.max(0, parseInt(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Target Omzet (Rp)</label>
            <input type="number" min={0} value={targetRevenue}
              onChange={(e) => setTargetRevenue(Math.max(0, parseFloat(e.target.value) || 0))} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Omzet Tercapai (Rp)</label>
            <input type="number" min={0} value={achievedRevenue}
              onChange={(e) => setAchievedRevenue(Math.max(0, parseFloat(e.target.value) || 0))} className={inputCls} />
          </div>
        </div>

        {/* Ringkasan gap live */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <p className="text-xs text-gray-500">Pencapaian OA</p>
            <p className="text-sm font-semibold text-gray-900">{achievedOa}/{targetOa} ({pctOa}%)</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-4 py-3">
            <p className="text-xs text-gray-500">Pencapaian Omzet</p>
            <p className="text-sm font-semibold text-gray-900">{pctRevenue}%</p>
          </div>
          <div className={`rounded-lg px-4 py-3 ${gapRevenue > 0 ? "bg-amber-50" : "bg-green-50"}`}>
            <p className="text-xs text-gray-500">Gap Omzet</p>
            <p className={`text-sm font-semibold ${gapRevenue > 0 ? "text-amber-700" : "text-green-700"}`}>
              {gapRevenue > 0 ? formatIDR(gapRevenue) : "Target tercapai"}
            </p>
          </div>
        </div>
      </div>

      {/* Item produk terjual */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Produk Terjual</h2>
          <button type="button" onClick={() => setItems((prev) => [...prev, emptyItem()])}
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
            <Plus className="h-3.5 w-3.5" /> Tambah Baris
          </button>
        </div>

        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 sm:col-span-3">
                {idx === 0 && <label className={labelCls}>Produk (master)</label>}
                <select value={item.product_id} onChange={(e) => selectProduct(idx, e.target.value)} className={inputCls}>
                  <option value="">— Manual —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-12 sm:col-span-3">
                {idx === 0 && <label className={labelCls}>Nama Produk</label>}
                <input type="text" value={item.product_name}
                  onChange={(e) => updateItem(idx, { product_name: e.target.value, product_id: "" })}
                  placeholder="Nama produk" className={inputCls} />
              </div>
              <div className="col-span-4 sm:col-span-2">
                {idx === 0 && <label className={labelCls}>Qty</label>}
                <input type="number" min={0} value={item.quantity}
                  onChange={(e) => updateItem(idx, { quantity: Math.max(0, parseFloat(e.target.value) || 0) })}
                  className={inputCls} />
              </div>
              <div className="col-span-3 sm:col-span-1">
                {idx === 0 && <label className={labelCls}>Satuan</label>}
                <input type="text" value={item.unit}
                  onChange={(e) => updateItem(idx, { unit: e.target.value })} className={inputCls} />
              </div>
              <div className="col-span-4 sm:col-span-2">
                {idx === 0 && <label className={labelCls}>Nilai (Rp)</label>}
                <input type="number" min={0} value={item.value}
                  onChange={(e) => updateItem(idx, { value: Math.max(0, parseFloat(e.target.value) || 0) })}
                  className={inputCls} />
              </div>
              <div className="col-span-1 flex justify-end">
                <button type="button" onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={items.length === 1}
                  className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Total */}
        <div className="mt-4 space-y-2 border-t border-gray-100 pt-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Total Nilai</span>
            <span className="font-medium text-gray-900">{formatIDR(totalValue)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">Diskon (Rp)</span>
            <input type="number" min={0} value={discount}
              onChange={(e) => setDiscount(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-40 rounded-lg border border-gray-200 px-3 py-1.5 text-right text-sm" />
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-sm">
            <span className="font-semibold text-gray-900">Grand Total</span>
            <span className="font-semibold text-gray-900">{formatIDR(grandTotal)}</span>
          </div>
        </div>
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
