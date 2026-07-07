"use client";

import { useState, useTransition } from "react";
import { createFirstUserAction } from "@/lib/platform/tenant-actions";
import { AlertCircle, CheckCircle2, Loader2, Eye, EyeOff } from "lucide-react";

export function FirstUserForm({ companyId }: { companyId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error,   setError]   = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  const [fullName,  setFullName]  = useState("");
  const [email,     setEmail]     = useState("");
  const [phone,     setPhone]     = useState("");
  const [password,  setPassword]  = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!fullName.trim() || !email.trim() || !password) {
      setError("Nama, email, dan password wajib diisi");
      return;
    }
    if (password.length < 8) {
      setError("Password minimal 8 karakter");
      return;
    }

    startTransition(async () => {
      const result = await createFirstUserAction(companyId, {
        full_name:     fullName.trim(),
        email:         email.trim(),
        phone:         phone.trim() || null,
        temp_password: password,
      });
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(true);
      }
    });
  }

  if (success) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-green-50 p-4">
        <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
        <div>
          <p className="text-sm font-medium text-green-800">User berhasil dibuat!</p>
          <p className="text-xs text-green-600 mt-0.5">
            Owner dapat login dengan email dan password yang telah ditetapkan.
            Sarankan segera ganti password setelah login pertama.
          </p>
        </div>
      </div>
    );
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-gray-700 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div>
        <label className={labelCls}>Nama Lengkap <span className="text-red-500">*</span></label>
        <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
          placeholder="John Doe" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Email <span className="text-red-500">*</span></label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="owner@perusahaan.com" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>No. Telepon</label>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="08123456789" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Password Sementara <span className="text-red-500">*</span></label>
        <div className="relative">
          <input type={showPwd ? "text" : "password"} value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Min. 8 karakter" className={`${inputCls} pr-10`} />
          <button type="button" onClick={() => setShowPwd(!showPwd)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-1 text-xs text-amber-600">Sarankan owner mengganti password setelah login pertama.</p>
      </div>
      <button type="submit" disabled={isPending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
        {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
        {isPending ? "Membuat User..." : "Buat Akun Owner"}
      </button>
    </form>
  );
}
