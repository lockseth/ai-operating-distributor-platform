import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata = {
  title: "Reset Password — AODP",
};

// Gate 3E-C-C2-B4-R1 — halaman ini boleh mengganti password HANYA bila sudah
// ada session valid: baik session recovery yang di-set /auth/confirm
// (verifyOtp berhasil), maupun session normal milik user must_change_password
// = TRUE (lihat get-user.ts, redirect ke sini selama flag masih TRUE).
// Sebelumnya guard ini hanya implisit lewat kegagalan updateUser() di
// reset-password-form.tsx -- eksplisit di sini supaya fail-closed tidak
// bergantung pada perilaku sisi client. Pesan error generik, sama seperti
// /auth/confirm, supaya tidak membocorkan detail internal.
//
// Gate 3E-D2-A-R2 — jalur recovery kedua yang tiba LANGSUNG di sini (bukan
// via /auth/confirm): resetPasswordForEmail() dipanggil dari client
// createBrowserClient (@supabase/ssr) yang flowType-nya HARDCODE "pkce"
// (createBrowserClient.js), jadi template email default {{ .ConfirmationURL }}
// -- setelah verifikasi di /auth/v1/verify milik Supabase -- redirect ke sini
// dengan query `code` (PKCE authorization code), bukan token hash ala
// /auth/confirm maupun fragment. exchangeCodeForSession(code) di server WAJIB dipanggil di sini
// sebelum getUser(), sama persis pola /auth/callback (Gate 3D-B3-F1), supaya
// code_verifier (cookie milik browser yang memicu resetPasswordForEmail())
// bisa ditukar jadi session. Fail-closed identik /auth/callback: code
// invalid/expired/exception -> redirect generik, pesan Supabase mentah tidak
// pernah bocor. Tanpa `code` (mis. path must_change_password di atas), guard
// ini transparan -- langsung lanjut ke getUser() seperti sebelumnya.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const supabase = await createClient();

  if (code) {
    // redirect() throws internally -- tidak pernah dipanggil di dalam try di
    // bawah (akan tertangkap catch generik-nya sendiri). exchangeFailed
    // hanya flag, redirect terjadi setelah blok try/catch selesai.
    let exchangeFailed = false;
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      exchangeFailed = Boolean(error);
    } catch {
      exchangeFailed = true;
    }
    if (exchangeFailed) {
      redirect("/login?error=recovery_failed");
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?error=recovery_failed");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <ResetPasswordForm />
    </main>
  );
}
