import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { FileSpreadsheet, Users, Zap, Globe, ChevronRight } from "lucide-react";

export const metadata = { title: "Pengaturan — AODP" };

const SETTING_SECTIONS = [
  {
    href: "/dashboard/settings/import",
    icon: <FileSpreadsheet className="h-5 w-5 text-blue-500" />,
    title: "Template Import (Lama)",
    description: "Lihat riwayat & template import lama. Untuk import data baru, gunakan menu Import Data.",
    available: true,
  },
  {
    href: "/dashboard/users",
    icon: <Users className="h-5 w-5 text-green-500" />,
    title: "Pengguna & Hak Akses",
    description: "Tambah pengguna, atur role, dan kelola izin akses per anggota tim.",
    available: true,
  },
  {
    href: "#",
    icon: <Zap className="h-5 w-5 text-orange-500" />,
    title: "Integrasi & Webhook",
    description: "Hubungkan dengan n8n, WhatsApp, dan layanan pihak ketiga lainnya.",
    available: false,
  },
  {
    href: "#",
    icon: <Globe className="h-5 w-5 text-purple-500" />,
    title: "Profil Perusahaan",
    description: "Ubah nama perusahaan, logo, domain, dan preferensi tampilan.",
    available: false,
  },
];

export default async function SettingsPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.permissions.includes("settings.view") ||
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("admin");

  if (!hasAccess) redirect("/dashboard");

  const planLabel: Record<string, string> = {
    free: "Free",
    starter: "Starter",
    growth: "Growth",
    enterprise: "Enterprise",
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Pengaturan"
        subtitle="Konfigurasi perusahaan, pengguna, dan integrasi."
      />

      {/* Company overview card */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Informasi Tenant
        </p>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-gray-500">Nama Perusahaan</p>
            <p className="mt-0.5 text-sm font-semibold text-gray-900">{user.company.name}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Subdomain</p>
            <p className="mt-0.5 text-sm font-mono text-gray-900">{user.company.slug}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Paket Langganan</p>
            <span className="mt-0.5 inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
              {planLabel[user.company.subscription_plan] ?? user.company.subscription_plan}
            </span>
          </div>
        </div>
      </div>

      {/* Setting sections */}
      <div className="flex flex-col gap-3">
        {SETTING_SECTIONS.map((section) =>
          section.available ? (
            <Link
              key={section.title}
              href={section.href}
              className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-blue-200 hover:bg-blue-50/40"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                {section.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900">{section.title}</p>
                <p className="mt-0.5 text-xs text-gray-500">{section.description}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
            </Link>
          ) : (
            <div
              key={section.title}
              className="flex cursor-default items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 opacity-60"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                {section.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900">{section.title}</p>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                    Segera Hadir
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">{section.description}</p>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
