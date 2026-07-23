"use client";

import { useState, useTransition } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import type { CustomerFormData } from "@/lib/customers/actions";

interface SalesUser { id: string; full_name: string; }
interface CoverageAreaOption { id: string; name: string; isActive: boolean; }

interface CustomerFormProps {
  initialData?: CustomerFormData;
  salesUsers: SalesUser[];
  coverageAreas: CoverageAreaOption[];
  action: (data: CustomerFormData) => Promise<void>;
  submitLabel?: string;
  cancelHref?: string;
}

const CUSTOMER_TYPES = [
  { value: "reseller",      label: "Reseller" },
  { value: "direct",        label: "Direct / Eceran" },
  { value: "distributor",   label: "Distributor" },
  { value: "modern_trade",  label: "Modern Trade" },
] as const;

export function CustomerForm({
  initialData,
  salesUsers,
  coverageAreas,
  action,
  submitLabel = "Simpan",
  cancelHref,
}: CustomerFormProps) {
  const isEditMode = Boolean(initialData);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name,            setName]            = useState(initialData?.name ?? "");
  const [code,            setCode]            = useState(initialData?.code ?? "");
  const [type,            setType]            = useState<CustomerFormData["type"]>(initialData?.type ?? "reseller");
  const [phone,           setPhone]           = useState(initialData?.phone ?? "");
  const [email,           setEmail]           = useState(initialData?.email ?? "");
  const [address,         setAddress]         = useState(initialData?.address ?? "");
  const [city,            setCity]            = useState(initialData?.city ?? "");
  const [coverageAreaId,  setCoverageAreaId]  = useState(initialData?.coverage_area_id ?? "");
  const [assignedSalesId, setAssignedSalesId] = useState(initialData?.assigned_sales_id ?? "");
  const [notes,           setNotes]           = useState(initialData?.notes ?? "");
  const [isActive,        setIsActive]        = useState(initialData?.is_active ?? true);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) { setError("Nama toko / reseller wajib diisi"); return; }
    if (!code.trim()) { setError("Kode pelanggan wajib diisi"); return; }

    const data: CustomerFormData = {
      name:              name.trim(),
      code:              code.trim().toUpperCase(),
      type,
      phone:             phone.trim() || null,
      email:             email.trim() || null,
      address:           address.trim() || null,
      city:              city.trim() || null,
      coverage_area_id:  coverageAreaId || null,
      assigned_sales_id: assignedSalesId || null,
      notes:             notes.trim() || null,
      is_active:         isActive,
      custom_fields:     {},
    };

    startTransition(async () => {
      try {
        await action(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-gray-700 mb-1";
  const section  = "rounded-xl border bg-white p-5 shadow-sm space-y-4";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Informasi Utama */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Informasi Toko / Reseller</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Nama Toko / Reseller <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Toko Sinar Jaya" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Kode Pelanggan <span className="text-red-500">*</span></label>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="RES-001" className={`${inputCls} font-mono`} />
          </div>
          <div>
            <label className={labelCls}>Tipe Pelanggan</label>
            <select value={type} onChange={(e) => setType(e.target.value as CustomerFormData["type"])}
              className={inputCls}>
              {CUSTOMER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Sales yang Menangani</label>
            <select value={assignedSalesId} onChange={(e) => setAssignedSalesId(e.target.value)}
              className={inputCls}>
              <option value="">— Belum ditugaskan —</option>
              {salesUsers.map((s) => (
                <option key={s.id} value={s.id}>{s.full_name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Kontak */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Informasi Kontak</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>No. Telepon / WhatsApp</label>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="08123456789" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="toko@email.com" className={inputCls} />
          </div>
        </div>
      </div>

      {/* Lokasi */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Lokasi</h2>
        <div>
          <label className={labelCls}>Alamat Lengkap</label>
          <textarea value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder="Jl. Merdeka No. 10, RT 03/RW 05"
            rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Kota / Kabupaten</label>
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)}
              placeholder="Surabaya" className={inputCls} />
            <p className="mt-1 text-xs text-gray-400">Data alamat — terpisah dari Wilayah Penjualan.</p>
          </div>
          <div>
            <label className={labelCls}>Wilayah Penjualan</label>
            <select value={coverageAreaId} onChange={(e) => setCoverageAreaId(e.target.value)} className={inputCls}>
              <option value="">— Belum ditetapkan —</option>
              {coverageAreas.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.isActive && a.id !== initialData?.coverage_area_id}>
                  {a.name}{!a.isActive ? " (nonaktif)" : ""}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">Master resmi dari Owner Control → Wilayah Penjualan.</p>
          </div>
        </div>
      </div>

      {/* Catatan */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Catatan Internal</h2>
        <div>
          <label className={labelCls}>Catatan</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Info tambahan tentang pelanggan ini..."
            rows={3} className={`${inputCls} resize-none`} />
          <p className="mt-1 text-xs text-gray-400">Tidak ditampilkan ke pelanggan</p>
        </div>
      </div>

      {/* Status — edit mode only */}
      {isEditMode && (
        <div className={section}>
          <h2 className="text-sm font-semibold text-gray-900">Status Pelanggan</h2>
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive(!isActive)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                isActive ? "bg-green-500" : "bg-gray-300"
              }`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                isActive ? "translate-x-6" : "translate-x-1"
              }`} />
            </button>
            <span className="text-sm text-gray-700">
              {isActive ? "Aktif" : "Nonaktif"}
            </span>
          </label>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {cancelHref && (
          <a href={cancelHref}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Batal
          </a>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Menyimpan..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
