import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { BarChart2, TrendingUp, RefreshCw, Download } from "lucide-react";

export const metadata = { title: "Laporan — AODP" };

const REPORT_CARDS = [
  {
    icon: <BarChart2 className="h-6 w-6 text-blue-500" />,
    title: "Revenue",
    description: "Ringkasan total omset, rata-rata nilai order, dan tren pendapatan per periode.",
    badge: "Segera Hadir",
    color: "blue",
  },
  {
    icon: <TrendingUp className="h-6 w-6 text-green-500" />,
    title: "Performa Sales",
    description: "Ranking Sales berdasarkan jumlah order, nilai transaksi, dan jumlah pelanggan aktif.",
    badge: "Segera Hadir",
    color: "green",
  },
  {
    icon: <RefreshCw className="h-6 w-6 text-orange-500" />,
    title: "Repeat Order",
    description: "Analisis frekuensi pembelian ulang, rata-rata jeda antar order, dan pelanggan paling loyal.",
    badge: "Segera Hadir",
    color: "orange",
  },
  {
    icon: <Download className="h-6 w-6 text-purple-500" />,
    title: "Export Laporan",
    description: "Unduh data pelanggan, produk, dan transaksi dalam format Excel atau CSV.",
    badge: "Segera Hadir",
    color: "purple",
  },
];

const BADGE_COLOR: Record<string, string> = {
  blue:   "bg-blue-50 text-blue-700",
  green:  "bg-green-50 text-green-700",
  orange: "bg-orange-50 text-orange-700",
  purple: "bg-purple-50 text-purple-700",
};

export default async function ReportsPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.permissions.includes("reports.view") ||
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager");

  if (!hasAccess) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Laporan"
        subtitle="Analisis performa bisnis, penjualan, dan aktivitas pelanggan."
      />

      {/* Status banner */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">
          Laporan sedang disiapkan
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Fitur laporan interaktif sedang dalam pengembangan dan akan tersedia dalam rilis berikutnya.
          Sementara itu, gunakan{" "}
          <span className="font-medium">AI Insights</span> untuk ringkasan analitik berbasis kecerdasan buatan.
        </p>
      </div>

      {/* Report cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {REPORT_CARDS.map((card) => (
          <div
            key={card.title}
            className="rounded-lg border border-gray-200 bg-white p-5 opacity-75"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                  {card.icon}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{card.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{card.description}</p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_COLOR[card.color]}`}
              >
                {card.badge}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* AI redirect hint */}
      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
        <p className="text-sm text-blue-800">
          Butuh analisis sekarang?{" "}
          <a href="/dashboard/ai" className="font-medium underline hover:text-blue-900">
            Buka AI Insights
          </a>{" "}
          untuk ringkasan eksekutif dan rekomendasi berbasis data real-time.
        </p>
      </div>
    </div>
  );
}
