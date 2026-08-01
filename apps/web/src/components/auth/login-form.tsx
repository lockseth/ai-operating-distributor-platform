"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { enterDemoModeAction } from "@/lib/actions/demo";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError("Email atau password tidak valid. Silakan coba lagi.");
      setLoading(false);
      return;
    }

    // Fire-and-forget audit log
    fetch("/api/auth/login-audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_agent: navigator.userAgent }),
    }).catch(() => {});

    // Redirect to /dashboard — server will resolve role-based destination
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">AODP</h1>
        <p className="mt-2 text-sm text-gray-600">
          Masuk ke AI Operating Distributor Platform Anda
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-700"
          >
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

        <div>
          <div className="flex items-center justify-between">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700"
            >
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              Lupa password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
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
          {loading ? "Memproses..." : "Masuk"}
        </button>
      </form>

      {process.env.NODE_ENV === "development" && (
        <form action={enterDemoModeAction} className="mt-3">
          <button
            type="submit"
            className="w-full rounded-lg border border-dashed border-amber-300 bg-amber-50
              px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100
              focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-2
              flex items-center justify-center gap-2"
          >
            🧪 Masuk Demo (Development Only)
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-gray-600">
        Belum punya akun?{" "}
        <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-800">
          Daftar
        </Link>
      </p>
    </div>
  );
}
