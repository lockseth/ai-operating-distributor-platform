"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import {
  buildProvisionRpcParams,
  classifyProvisionError,
  classifySignUpOutcome,
  validateContinueOnboardingInput,
  validateSignupInput,
} from "@/lib/auth/signup";

// Gate 3D-B3 — public first-owner signup UI.
//
// Desain: company_name/full_name/phone TIDAK PERNAH dibawa lewat
// user_metadata atau storage browser melewati email-confirmation. RPC
// public.provision_first_owner() menerima ketiganya sebagai parameter
// eksplisit setiap kali dipanggil, jadi form ini cukup mengumpulkan ulang
// ketiganya tepat pada saat session terautentikasi benar-benar tersedia
// (langsung setelah signUp() bila confirm-email OFF, atau di layar
// "continue" begitu link konfirmasi menghasilkan session). Layar "continue"
// yang sama juga dipakai untuk retry setelah provisioning gagal — tidak ada
// mekanisme carry-across-confirmation yang perlu diciptakan sama sekali,
// sehingga tidak ada gap kontrak untuk itu (lihat auth/AODP_GATE_3D_A...
// §5.A.5 / G6).
//
// RPC dipanggil LANGSUNG dari client memakai sesi user (anon key), TIDAK
// PERNAH lewat server action/admin client — sesuai GRANT EXECUTE RPC ini
// yang hanya ke `authenticated`, bukan `service_role`.

type Phase = "checking" | "signup" | "check-email" | "continue" | "redirecting";

const initialSignupState = {
  email: "",
  password: "",
  confirmPassword: "",
  companyName: "",
  fullName: "",
  phone: "",
};

export function SignupForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateEmail, setDuplicateEmail] = useState(false);
  const [loading, setLoading] = useState(false);

  const [signupState, setSignupState] = useState(initialSignupState);
  const [continueState, setContinueState] = useState({ companyName: "", fullName: "", phone: "" });

  const evaluateSession = useCallback(
    async (session: Session | null) => {
      const supabase = createClient();

      if (!session) {
        setPhase((current) => (current === "check-email" ? current : "signup"));
        return;
      }

      setSessionEmail(session.user.email ?? null);

      // Sudah punya profil (== sudah pernah sukses diprovisi) -> jangan
      // menjalankan provisioning ulang, langsung ke dashboard.
      const { data: profile } = await supabase
        .from("users")
        .select("id")
        .eq("id", session.user.id)
        .maybeSingle();

      if (profile) {
        setPhase("redirecting");
        router.replace("/dashboard");
        return;
      }

      setContinueState((s) => ({ ...s, fullName: s.fullName || "" }));
      setPhase("continue");
    },
    [router]
  );

  useEffect(() => {
    const supabase = createClient();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) evaluateSession(data.session);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) evaluateSession(session);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [evaluateSession]);

  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDuplicateEmail(false);

    const validationError = validateSignupInput(signupState);
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: signupState.email.trim(),
      password: signupState.password,
      options: {
        // Fixed, same-origin path -- tidak pernah diturunkan dari query
        // param/input pengguna, mirror pola redirectTo di forgot-password-form.
        emailRedirectTo: `${window.location.origin}/signup`,
      },
    });

    const outcome = classifySignUpOutcome(signUpError, data);

    if (outcome.kind === "duplicate_email") {
      setDuplicateEmail(true);
      setLoading(false);
      return;
    }

    if (outcome.kind === "unexpected_error") {
      setError("Gagal mendaftar. Silakan coba lagi.");
      setLoading(false);
      return;
    }

    if (outcome.kind === "confirmation_required") {
      setPhase("check-email");
      setLoading(false);
      return;
    }

    // session_ready: confirm-email OFF di project ini -- session sudah aktif,
    // lanjutkan provisioning sekarang juga dengan data yang baru diisi.
    await submitProvisioning({
      companyName: signupState.companyName,
      fullName: signupState.fullName,
      phone: signupState.phone,
    });
  }

  async function submitProvisioning(input: { companyName: string; fullName: string; phone: string }) {
    const validationError = validateContinueOnboardingInput(input);
    if (validationError) {
      setError(validationError);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc(
      "provision_first_owner",
      buildProvisionRpcParams(input)
    );

    if (!rpcError) {
      setPhase("redirecting");
      router.replace("/dashboard");
      return;
    }

    const outcome = classifyProvisionError(rpcError);

    if (outcome.kind === "already_provisioned") {
      setPhase("redirecting");
      router.replace("/dashboard");
      return;
    }

    if (outcome.kind === "unauthenticated") {
      setError("Sesi Anda berakhir. Silakan masuk kembali untuk melanjutkan pendaftaran.");
      setPhase("signup");
      setLoading(false);
      return;
    }

    if (outcome.kind === "invalid_input") {
      setError("Data tidak valid. Periksa kembali isian Anda.");
      setLoading(false);
      return;
    }

    // unexpected_error: auth user & session TETAP dipertahankan -- tetap di
    // layar "continue" supaya pengguna bisa retry aman tanpa signUp ulang.
    setError("Gagal menyelesaikan pendaftaran. Silakan coba lagi.");
    setLoading(false);
  }

  async function handleContinueSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submitProvisioning(continueState);
  }

  if (phase === "checking" || phase === "redirecting") {
    return (
      <div className="w-full max-w-sm text-center text-sm text-gray-500">
        Memuat...
      </div>
    );
  }

  if (phase === "check-email") {
    return (
      <div className="w-full max-w-sm text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mx-auto">
          <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Periksa Email Anda</h2>
        <p className="mt-2 text-sm text-gray-600">
          Kami telah mengirim link konfirmasi ke <strong>{signupState.email}</strong>.
          Klik link tersebut untuk melanjutkan pendaftaran.
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

  if (phase === "continue") {
    return (
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Lengkapi Pendaftaran</h1>
          <p className="mt-2 text-sm text-gray-600">
            {sessionEmail ? <>Masuk sebagai <strong>{sessionEmail}</strong>. </> : null}
            Lengkapi data perusahaan Anda untuk menyelesaikan pendaftaran.
          </p>
        </div>

        <form onSubmit={handleContinueSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          <div>
            <label htmlFor="companyName" className="block text-sm font-medium text-gray-700">
              Nama Perusahaan
            </label>
            <input
              id="companyName"
              type="text"
              required
              value={continueState.companyName}
              onChange={(e) => setContinueState((s) => ({ ...s, companyName: e.target.value }))}
              placeholder="PT Sumber Warna Alam"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
                placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
                focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="fullName" className="block text-sm font-medium text-gray-700">
              Nama Lengkap Anda
            </label>
            <input
              id="fullName"
              type="text"
              required
              value={continueState.fullName}
              onChange={(e) => setContinueState((s) => ({ ...s, fullName: e.target.value }))}
              placeholder="Nama lengkap"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
                placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
                focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
              Nomor Telepon <span className="text-gray-400">(opsional)</span>
            </label>
            <input
              id="phone"
              type="tel"
              value={continueState.phone}
              onChange={(e) => setContinueState((s) => ({ ...s, phone: e.target.value }))}
              placeholder="08xx-xxxx-xxxx"
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
            {loading ? "Memproses..." : "Selesaikan Pendaftaran"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Daftar AODP</h1>
        <p className="mt-2 text-sm text-gray-600">
          Buat akun pemilik pertama untuk perusahaan Anda.
        </p>
      </div>

      <form onSubmit={handleSignupSubmit} className="space-y-4">
        {duplicateEmail && (
          <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            Email sudah terdaftar.{" "}
            <Link href="/login" className="font-medium underline">
              Masuk
            </Link>{" "}
            atau{" "}
            <Link href="/forgot-password" className="font-medium underline">
              lupa password
            </Link>
            .
          </div>
        )}
        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

        <div>
          <label htmlFor="companyName" className="block text-sm font-medium text-gray-700">
            Nama Perusahaan
          </label>
          <input
            id="companyName"
            type="text"
            required
            value={signupState.companyName}
            onChange={(e) => setSignupState((s) => ({ ...s, companyName: e.target.value }))}
            placeholder="PT Sumber Warna Alam"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="fullName" className="block text-sm font-medium text-gray-700">
            Nama Lengkap Anda
          </label>
          <input
            id="fullName"
            type="text"
            required
            value={signupState.fullName}
            onChange={(e) => setSignupState((s) => ({ ...s, fullName: e.target.value }))}
            placeholder="Nama lengkap"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700">
            Nomor Telepon <span className="text-gray-400">(opsional)</span>
          </label>
          <input
            id="phone"
            type="tel"
            value={signupState.phone}
            onChange={(e) => setSignupState((s) => ({ ...s, phone: e.target.value }))}
            placeholder="08xx-xxxx-xxxx"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={signupState.email}
            onChange={(e) => setSignupState((s) => ({ ...s, email: e.target.value }))}
            placeholder="email@perusahaan.com"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={signupState.password}
            onChange={(e) => setSignupState((s) => ({ ...s, password: e.target.value }))}
            placeholder="Minimal 8 karakter"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm
              placeholder-gray-400 shadow-sm focus:border-blue-500 focus:outline-none
              focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
            Konfirmasi Password
          </label>
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            value={signupState.confirmPassword}
            onChange={(e) => setSignupState((s) => ({ ...s, confirmPassword: e.target.value }))}
            placeholder="Ulangi password"
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
          {loading ? "Memproses..." : "Daftar"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        Sudah punya akun?{" "}
        <Link href="/login" className="font-medium text-blue-600 hover:text-blue-800">
          Masuk
        </Link>
      </p>
    </div>
  );
}
