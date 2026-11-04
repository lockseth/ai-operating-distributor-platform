"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

// Gate 3E-D2-A-R3 -- setelah verifyOtp({ type: "recovery" }) sukses, magic
// link (Gate 3E-D2-A-R2) TIDAK dipakai lagi sebagai jalur utama: PKCE
// code_verifier tersimpan per-browser (lihat page.tsx reset-password),
// sehingga gagal setiap kali link diklik dari device/browser BERBEDA dari
// yang memicu resetPasswordForEmail() -- kasus normal untuk email recovery
// (kirim dari satu tempat, dibuka dari inbox di tempat lain). OTP 8-digit
// yang diketik manual TIDAK bergantung sama sekali pada code_verifier --
// verifyOtp({ email, token, type }) murni pasangan email+kode, bisa
// diverifikasi dari device manapun. resetPasswordForEmail() TETAP dipanggil
// apa adanya (redirectTo dipertahankan, request sama) -- OTP dan link magic
// dihasilkan dari request yang SAMA, kita hanya mengarahkan user memakai
// kode, bukan link.
export function ForgotPasswordForm() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "otp" | "verified">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: `${window.location.origin}/reset-password`,
      }
    );

    if (resetError) {
      setError("Gagal mengirim kode reset. Pastikan email terdaftar.");
      setLoading(false);
      return;
    }

    setStep("otp");
    setLoading(false);
  }

  // Gate 3E-D2-A-R3 -- verifyOtp sukses membuat sesi authenticated (BUKAN
  // sesi khusus "recovery-only" terpisah, sama seperti login biasa dari sisi
  // Supabase Auth). begin_self_recovery_password_change() (migration
  // 20260914000001) dipanggil SEGERA sesudahnya, SEBELUM redirect ke
  // dashboard -- ini yang mengunci must_change_password=TRUE, memakai ulang
  // gate dashboard get-user.ts/reset-password yang sudah ada (TIDAK diubah
  // gate ini) supaya dashboard tetap terkunci sampai password sungguh
  // diganti. Kegagalan RPC (mis. exception tak terduga) TIDAK PERNAH
  // dianggap sukses -- fail-closed ke pesan error generik, sesi recovery
  // yang sudah terlanjur terbentuk tidak diarahkan ke dashboard.
  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: "recovery",
    });

    if (verifyError) {
      setError("Kode salah atau sudah kedaluwarsa. Coba lagi atau minta kode baru.");
      setLoading(false);
      return;
    }

    const { error: rpcError } = await supabase.rpc("begin_self_recovery_password_change");

    if (rpcError) {
      setError("Verifikasi berhasil tapi terjadi kesalahan. Coba lagi.");
      setLoading(false);
      return;
    }

    setStep("verified");
    router.push("/dashboard");
  }

  if (step === "verified") {
    return (
      <div className="w-full max-w-sm text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mx-auto">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Verifikasi Berhasil</h2>
        <p className="mt-2 text-sm text-gray-600">
          Demi keamanan akun, buat password baru sebelum melanjutkan.
        </p>
      </div>
    );
  }

  if (step === "otp") {
    return (
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Masukkan Kode</h1>
          <p className="mt-2 text-sm text-gray-600">
            Kami mengirim kode reset ke <strong>{email}</strong>. Masukkan kode
            tersebut di bawah ini.
          </p>
        </div>

        <form onSubmit={handleVerifyOtp} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="otp" className="block text-sm font-medium text-gray-700">
              Kode Reset
            </label>
            <input
              id="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="Masukkan kode dari email"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
                placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
                focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium
              text-white hover:bg-blue-700 focus:outline-none focus:ring-2
              focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50
              disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            {loading ? "Memverifikasi..." : "Verifikasi Kode"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Ingat password Anda?{" "}
          <Link href="/login" className="font-medium text-blue-600 hover:text-blue-800">
            Masuk
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Lupa Password</h1>
        <p className="mt-2 text-sm text-gray-600">
          Masukkan email Anda. Kami akan mengirim kode untuk reset password.
        </p>
      </div>

      <form onSubmit={handleSendOtp} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@perusahaan.com"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium
            text-white hover:bg-blue-700 focus:outline-none focus:ring-2
            focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50
            disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {loading && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
          )}
          {loading ? "Mengirim..." : "Kirim Kode Reset"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        Ingat password Anda?{" "}
        <Link href="/login" className="font-medium text-blue-600 hover:text-blue-800">
          Masuk
        </Link>
      </p>
    </div>
  );
}
