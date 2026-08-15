"use client";

// =============================================================================
// Form "Tambah Toko" (dashboard, jalur utama pengganti CustomerForm untuk
// create) -- memanggil createStoreAction (create_store_with_pic RPC, sama
// dengan yang dipakai Telegram, deteksi duplikat tenant-scoped bawaan).
// Nama+telepon PIC WAJIB (tidak diubah dari kontrak RPC existing). Foto
// depan toko, foto PIC, dan GPS SEMUA opsional -- toko yang mau transaksi
// CASH cepat tetap bisa disimpan tanpa itu (keputusan Pak Waluyo, 2026-08-15).
// =============================================================================

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, AlertTriangle, MapPin, CheckCircle2 } from "lucide-react";
import { createStoreAction } from "@/lib/customer-pic/actions";
import { PIC_ROLES, PIC_ROLE_LABEL, type PicRole } from "@/lib/customer-pic/types";
import { PhotoCaptureInput } from "./photo-capture-input";

interface SalesUser { id: string; full_name: string; }
interface CoverageAreaOption { id: string; name: string; isActive: boolean; }

interface AddStoreFormProps {
  salesUsers: SalesUser[];
  coverageAreas: CoverageAreaOption[];
  cancelHref?: string;
}

type DuplicateWarning = { duplicateCustomerId: string } | null;

export function AddStoreForm({ salesUsers, coverageAreas, cancelHref }: AddStoreFormProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedDuplicate, setBlockedDuplicate] = useState<string | null>(null);
  const [similarDuplicate, setSimilarDuplicate] = useState<DuplicateWarning>(null);
  const [overrideReason, setOverrideReason] = useState("");

  const [storeName, setStoreName] = useState("");
  const [storePhone, setStorePhone] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [storeAreaName, setStoreAreaName] = useState("");
  const [assignedSalesId, setAssignedSalesId] = useState("");

  const [picName, setPicName] = useState("");
  const [picPhone, setPicPhone] = useState("");
  const [picEmail, setPicEmail] = useState("");
  const [picRoles, setPicRoles] = useState<PicRole[]>([]);

  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);

  const [storePhotoUrl, setStorePhotoUrl] = useState<string | null>(null);
  const [picPhotoUrl, setPicPhotoUrl] = useState<string | null>(null);

  const [idempotencyKey] = useState(() => `admin-store:${crypto.randomUUID()}`);

  function toggleRole(role: PicRole) {
    setPicRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  function captureGps() {
    if (!navigator.geolocation) {
      setGpsError("Perangkat tidak mendukung GPS.");
      return;
    }
    setGpsLoading(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLoading(false);
      },
      () => {
        setGpsError("Gagal mengambil lokasi -- pastikan izin lokasi diaktifkan.");
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  function validate(): string | null {
    if (!storeName.trim()) return "Nama toko wajib diisi.";
    if (!picName.trim() || !picPhone.trim()) return "Nama dan nomor PIC wajib diisi.";
    if (picRoles.length === 0) return "Pilih minimal satu peran PIC.";
    return null;
  }

  async function submit(withOverride: boolean) {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (withOverride && !overrideReason.trim()) {
      setError("Alasan wajib diisi untuk melanjutkan meski mirip toko lain.");
      return;
    }

    setError(null);
    setBlockedDuplicate(null);
    setIsPending(true);

    try {
      const result = await createStoreAction({
        storeName: storeName.trim(),
        storePhone: storePhone.trim() || null,
        storeAddress: storeAddress.trim() || null,
        storeArea: storeAreaName || null,
        storeLatitude: gps?.lat ?? null,
        storeLongitude: gps?.lng ?? null,
        assignedSalesId: assignedSalesId || null,
        picName: picName.trim(),
        picPhone: picPhone.trim(),
        picEmail: picEmail.trim() || null,
        picRoles,
        overrideSimilarDuplicate: withOverride,
        overrideReason: withOverride ? overrideReason.trim() : null,
        storePhotoUrl,
        picPhotoUrl,
        idempotencyKey,
      });

      if (result.ok && result.customerId) {
        router.push(`/dashboard/customers/${result.customerId}`);
        return;
      }

      if (result.outcome === "exact_duplicate_store") {
        setBlockedDuplicate(result.duplicateCustomerId ?? null);
        setIsPending(false);
        return;
      }
      if (result.outcome === "similar_duplicate_warning") {
        setSimilarDuplicate({ duplicateCustomerId: result.duplicateCustomerId ?? "" });
        setIsPending(false);
        return;
      }

      setError(result.error ?? "Gagal menyimpan toko.");
      setIsPending(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      setIsPending(false);
    }
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-gray-700 mb-1";
  const section  = "rounded-xl border bg-white p-5 shadow-sm space-y-4";

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {blockedDuplicate && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Toko ini sudah terdaftar persis (nama sama + alamat/telepon sama).</p>
            <a href={`/dashboard/customers/${blockedDuplicate}`} className="underline text-red-800">
              Lihat toko yang sudah ada →
            </a>
          </div>
        </div>
      )}

      {similarDuplicate && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Ditemukan toko yang mirip.</p>
              <a href={`/dashboard/customers/${similarDuplicate.duplicateCustomerId}`} className="underline">
                Lihat toko yang mirip →
              </a>
              <p className="mt-1 text-xs">Kalau ini memang toko berbeda, isi alasan lalu lanjutkan.</p>
            </div>
          </div>
          <textarea
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Alasan kenapa ini toko yang berbeda..."
            rows={2}
            className="w-full rounded-lg border border-amber-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={() => submit(true)}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {isPending ? "Menyimpan..." : "Tetap Simpan sebagai Toko Baru"}
            </button>
            <button
              type="button"
              onClick={() => setSimilarDuplicate(null)}
              className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
            >
              Batal
            </button>
          </div>
        </div>
      )}

      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Informasi Toko</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Nama Toko <span className="text-red-500">*</span></label>
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)}
              placeholder="Toko Sinar Jaya" className={inputCls} disabled={isPending} />
          </div>
          <div>
            <label className={labelCls}>No. Telepon / WhatsApp Toko</label>
            <input value={storePhone} onChange={(e) => setStorePhone(e.target.value)}
              placeholder="08123456789" className={inputCls} disabled={isPending} />
          </div>
          <div>
            <label className={labelCls}>Sales yang Menangani</label>
            <select value={assignedSalesId} onChange={(e) => setAssignedSalesId(e.target.value)}
              className={inputCls} disabled={isPending}>
              <option value="">— Belum ditugaskan —</option>
              {salesUsers.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Wilayah Penjualan</label>
            <select value={storeAreaName} onChange={(e) => setStoreAreaName(e.target.value)}
              className={inputCls} disabled={isPending}>
              <option value="">— Belum ditetapkan —</option>
              {coverageAreas.filter((a) => a.isActive).map((a) => (
                <option key={a.id} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Alamat Lengkap</label>
          <textarea value={storeAddress} onChange={(e) => setStoreAddress(e.target.value)}
            placeholder="Jl. Merdeka No. 10, RT 03/RW 05" rows={2}
            className={`${inputCls} resize-none`} disabled={isPending} />
        </div>
      </div>

      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">PIC (Penanggung Jawab Toko)</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Nama PIC <span className="text-red-500">*</span></label>
            <input value={picName} onChange={(e) => setPicName(e.target.value)}
              placeholder="Nama penanggung jawab" className={inputCls} disabled={isPending} />
          </div>
          <div>
            <label className={labelCls}>No. WhatsApp PIC <span className="text-red-500">*</span></label>
            <input value={picPhone} onChange={(e) => setPicPhone(e.target.value)}
              placeholder="08123456789" className={inputCls} disabled={isPending} />
          </div>
          <div>
            <label className={labelCls}>Email PIC <span className="text-gray-400 font-normal">(opsional)</span></label>
            <input type="email" value={picEmail} onChange={(e) => setPicEmail(e.target.value)}
              placeholder="kalau ada" className={inputCls} disabled={isPending} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Peran PIC <span className="text-red-500">*</span></label>
          <div className="flex flex-wrap gap-3">
            {PIC_ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" checked={picRoles.includes(role)} onChange={() => toggleRole(role)} disabled={isPending} />
                {PIC_ROLE_LABEL[role]}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Lokasi & Foto <span className="text-gray-400 font-normal text-xs">(opsional, boleh dilewati)</span></h2>
        <div>
          <label className={labelCls}>Titik Lokasi GPS</label>
          {gps ? (
            <p className="flex items-center gap-1.5 text-xs text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Lokasi tersimpan ({gps.lat.toFixed(5)}, {gps.lng.toFixed(5)})
            </p>
          ) : (
            <button type="button" onClick={captureGps} disabled={gpsLoading || isPending}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-60">
              {gpsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
              Ambil Lokasi Saat Ini
            </button>
          )}
          {gpsError && <p className="mt-1 text-xs text-red-600">{gpsError}</p>}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PhotoCaptureInput label="Foto Depan Toko" onUploaded={setStorePhotoUrl} />
          <PhotoCaptureInput label="Foto PIC" onUploaded={setPicPhotoUrl} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        {cancelHref && (
          <a href={cancelHref} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Batal
          </a>
        )}
        <button
          type="button"
          disabled={isPending}
          onClick={() => submit(false)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Menyimpan..." : "Simpan Toko"}
        </button>
      </div>
    </div>
  );
}
