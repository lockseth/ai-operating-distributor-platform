import { LoginForm } from "@/components/auth/login-form";
import { resolveLoginBranding } from "@/lib/branding/login-branding";

export const metadata = {
  title: "Masuk — AODP",
  description: "Masuk ke Distribution Operating System Anda",
};

export default function LoginPage() {
  const branding = resolveLoginBranding({
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_DEMO_COMPANY_NAME: process.env.NEXT_PUBLIC_DEMO_COMPANY_NAME,
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        {branding.isDemoEnvironment && (
          <div className="mb-4 text-center">
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-3 py-1 text-xs font-semibold text-purple-700">
              DEMO ENVIRONMENT
            </span>
            {branding.companyName && (
              <p className="mt-2 text-sm font-semibold text-gray-800">{branding.companyName}</p>
            )}
            <p className="mt-1 text-xs text-gray-500">
              Kelola penjualan, pengiriman, piutang, dan aktivitas Salesman dalam satu sistem.
            </p>
          </div>
        )}
        <LoginForm />
        <p className="mt-6 text-center text-xs text-gray-400">Powered by AODP</p>
      </div>
    </main>
  );
}
