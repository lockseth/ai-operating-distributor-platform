"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
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
      setError("Gagal mengirim email reset. Pastikan email terdaftar.");
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  }

  if (success) {
    return (
      <div className="w-full max-w-sm text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mx-auto">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Email Terkirim</h2>
        <p className="mt-2 text-sm text-gray-600">
          Link reset password telah dikirim ke <strong>{email}</strong>.
          Silakan cek inbox Anda.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-sm font-medium text-blue-600 hover:text-blue-800"
        >
          Kembali ke halaman masuk
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Lupa Password</h1>
        <p className="mt-2 text-sm text-gray-600">
          Masukkan email Anda. Kami akan mengirim link untuk reset password.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
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
          {loading ? "Mengirim..." : "Kirim Link Reset"}
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
