"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { createSalesmanAction } from "@/lib/salesman/actions";

export function AddSalesmanForm({ availableAreas }: { availableAreas: string[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tempPassword, setTempPassword] = useState("");
  const [areas, setAreas] = useState<string[]>([]);

  function toggleArea(area: string) {
    setAreas((prev) => (prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!fullName.trim() || !email.trim() || !tempPassword) {
      setError("Nama, email, dan password sementara wajib diisi.");
      return;
    }
    if (tempPassword.length < 8) {
      setError("Password sementara minimal 8 karakter.");
      return;
    }
    if (areas.length === 0) {
      setError("Pilih minimal satu wilayah kerja.");
      return;
    }

    startTransition(async () => {
      const result = await createSalesmanAction({
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        tempPassword,
        areas,
      });
      if (!result.ok) {
        setError(result.error ?? "Gagal membuat Salesman.");
        return;
      }
      setSuccess(true);
    });
  }

  if (success) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-green-50 p-4">
        <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
        <div>
          <p className="text-sm font-medium text-green-800">Salesman berhasil dibuat.</p>
          <p className="mt-0.5 text-xs text-green-600">
            Salesman muncul di daftar Pengguna berstatus &ldquo;Belum Terhubung&rdquo;. Terbitkan
            kode pairing Telegram dari halaman Pengguna untuk mengaktifkan enrollment.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/dashboard/users")}
          className="ml-auto shrink-0 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
        >
          Ke daftar Pengguna
        </button>
      </div>
    );
  }

  const inputCls =
    "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "mb-1 block text-xs font-medium text-gray-700";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div>
        <label className={labelCls}>
          Nama Lengkap <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Budi Santoso"
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>
          Email <span className="text-red-500">*</span>
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="salesman@distributor.com"
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>No. Telepon</label>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="08123456789"
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>
          Password Sementara <span className="text-red-500">*</span>
        </label>
        <div className="relative">
          <input
            type={showPwd ? "text" : "password"}
            value={tempPassword}
            onChange={(e) => setTempPassword(e.target.value)}
            placeholder="Min. 8 karakter"
            className={`${inputCls} pr-10`}
          />
          <button
            type="button"
            onClick={() => setShowPwd(!showPwd)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-1 text-xs text-amber-600">
          Sarankan Salesman mengganti password setelah login pertama.
        </p>
      </div>

      <div>
        <label className={labelCls}>
          Wilayah Kerja <span className="text-red-500">*</span>
        </label>
        {availableAreas.length === 0 ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Tenant ini belum memiliki konfigurasi wilayah kerja. Hubungi admin untuk
            menambahkannya terlebih dahulu sebelum membuat Salesman.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {availableAreas.map((area) => {
              const active = areas.includes(area);
              return (
                <button
                  key={area}
                  type="button"
                  onClick={() => toggleArea(area)}
                  aria-pressed={active}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "border-blue-500 bg-blue-600 text-white"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {area}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1 text-xs text-gray-400">Bisa pilih lebih dari satu wilayah.</p>
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        Setelah dibuat, hubungkan akun Telegram Salesman dari halaman Pengguna. Tidak
        diperlukan KTP, selfie, atau foto identitas.
      </div>

      <button
        type="submit"
        disabled={isPending || availableAreas.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Membuat Salesman..." : "Buat Salesman"}
      </button>
    </form>
  );
}
