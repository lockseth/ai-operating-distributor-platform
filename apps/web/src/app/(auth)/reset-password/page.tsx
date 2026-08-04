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
export default async function ResetPasswordPage() {
  const supabase = await createClient();
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
