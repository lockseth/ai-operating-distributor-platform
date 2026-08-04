"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Copy, Loader2, ShieldAlert } from "lucide-react";
import {
  createTenantUserAction,
  type CreateTenantUserActionResult,
} from "@/lib/tenant-users/actions";

// Gate 3E-C-C2-B3 -- Owner Control Plane. Role selector SENGAJA hardcode ke
// {admin, sales} di sini (bukan diturunkan dari daftar role tenant lain yang
// mungkin ada di masa depan) -- allowlist ini adalah kontrak, bukan pilihan
// tampilan, ditegakkan ulang di service.ts (isTenantAssignableRole) dan RPC
// provision_owner_created_tenant_user (migration 20260911000001). owner dan
// super_admin TIDAK PERNAH boleh muncul di sini.
const ROLE_OPTIONS: { value: "admin" | "sales"; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "sales", label: "Sales" },
];

type CreatedIdentity = {
  fullName: string;
  email: string;
  role: "admin" | "sales";
  tempPassword: string;
};

export function AddTenantUserForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Satu-satunya tempat tempPassword pernah disimpan -- state komponen ini,
  // yang lenyap begitu form unmount (navigasi/refresh). Tidak pernah ditulis
  // ke localStorage/sessionStorage/URL/console -- lihat handleDismiss() yang
  // secara eksplisit membersihkan state ini sebelum navigasi, supaya password
  // tidak bisa "diintip lagi" lewat back-button ke komponen yang sama.
  const [created, setCreated] = useState<CreatedIdentity | null>(null);
  const [copied, setCopied] = useState(false);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"admin" | "sales">("sales");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // isPending sebagai guard utama double-submit (tombol disabled selama
    // pending) -- pengecekan eksplisit di sini mencegah race submit ganda
    // dari event yang sudah terlanjur di-dispatch sebelum re-render disabled
    // sempat diterapkan browser.
    if (isPending) return;

    if (!fullName.trim() || fullName.trim().length < 2) {
      setError("Nama lengkap wajib diisi (minimal 2 karakter).");
      return;
    }
    if (!email.trim()) {
      setError("Email wajib diisi.");
      return;
    }

    startTransition(async () => {
      let result: CreateTenantUserActionResult;
      try {
        result = await createTenantUserAction({
          fullName: fullName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          role,
        });
      } catch {
        // Fail closed -- tidak pernah menampilkan detail exception mentah ke
        // owner, dan tidak pernah menganggap ini sukses parsial.
        setError("Gagal membuat pengguna. Coba lagi atau hubungi administrator.");
        return;
      }

      if (!result.ok || !result.tempPassword) {
        setError(result.error ?? "Gagal membuat pengguna.");
        return;
      }

      setCreated({
        fullName: fullName.trim(),
        email: email.trim(),
        role,
        tempPassword: result.tempPassword,
      });
    });
  }

  function handleCopy() {
    if (!created) return;
    navigator.clipboard?.writeText(created.tempPassword).catch(() => {});
    setCopied(true);
  }

  function handleDismiss() {
    // Password dibersihkan dari state SEBELUM navigasi -- setelah titik ini
    // tidak ada cara bagi UI untuk menampilkannya lagi (tidak pernah
    // disimpan di tempat lain, dan tidak ada endpoint yang mengembalikannya
    // ulang -- lihat catatan actions.ts/workflow.ts).
    setCreated(null);
    setCopied(false);
    router.push("/dashboard/users");
    router.refresh();
  }

  if (created) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-lg bg-green-50 p-4">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
          <div>
            <p className="text-sm font-medium text-green-800">Pengguna berhasil dibuat.</p>
            <p className="mt-0.5 text-xs text-green-600">
              {created.fullName} ({created.email}) — role{" "}
              {ROLE_OPTIONS.find((r) => r.value === created.role)?.label}.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-800">
                Password sementara — catat sekarang, tidak akan ditampilkan lagi.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-sm text-gray-900">
                  {created.tempPassword}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 py-2 text-xs font-medium text-amber-700 hover:bg-amber-100"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? "Tersalin" : "Salin"}
                </button>
              </div>
              <p className="mt-2 text-xs text-amber-700">
                {ROLE_OPTIONS.find((r) => r.value === created.role)?.label} ini wajib
                mengganti password saat login pertama sebelum bisa mengakses dashboard.
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Selesai, ke daftar Pengguna
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
          placeholder="pengguna@distributor.com"
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
          Role <span className="text-red-500">*</span>
        </label>
        <div className="flex gap-2">
          {ROLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setRole(opt.value)}
              aria-pressed={role === opt.value}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                role === opt.value
                  ? "border-blue-500 bg-blue-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
        Password sementara dibuat otomatis oleh sistem dan hanya ditampilkan sekali
        setelah pengguna berhasil dibuat. Pengguna wajib menggantinya saat login pertama.
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Membuat Pengguna..." : "Tambah Pengguna"}
      </button>
    </form>
  );
}
