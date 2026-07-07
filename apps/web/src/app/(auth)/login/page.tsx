import { LoginForm } from "@/components/auth/login-form";

export const metadata = {
  title: "Masuk — AODP",
  description: "Masuk ke Distribution Operating System Anda",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <LoginForm />
    </main>
  );
}
