import { SignupForm } from "@/components/auth/signup-form";

export const metadata = {
  title: "Daftar — AODP",
  description: "Buat akun pemilik pertama untuk perusahaan Anda",
};

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <SignupForm />
    </main>
  );
}
