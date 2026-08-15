import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getExecutiveOverview } from "@/lib/executive/service";
import { getOwnerSalesKpiPerformance } from "@/lib/dashboard/owner-sales-kpi-performance";
import { fetchOwnerDashboardData } from "@/lib/dashboard/owner-metrics";
import { BriefingCard } from "@/components/executive/briefing-card";
import { ActionsCard } from "@/components/executive/actions-card";
import { BusinessHealthCard } from "@/components/executive/business-health-card";
import { KpiGrid } from "@/components/executive/kpi-grid";
import { SalesPerformanceCard } from "@/components/executive/sales-performance-card";
import { ChartCard } from "@/components/ui/chart-card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/dashboard/status-badge";
import {
  RevenueTrendChart,
  AreaPerformanceChart,
} from "@/components/dashboard/revenue-chart";
import {
  TrendingUp,
  Activity,
  Calendar,
  ShieldAlert,
  Users,
  FileText,
  Settings,
  ShoppingCart,
  Clock,
  CheckCircle2,
} from "lucide-react";
import type { RecentOrder, FollowUpCustomer } from "@/lib/dashboard/owner-metrics";

export const metadata = { title: "Executive Intelligence — AODP" };

// =============================================================================
// Executive Intelligence — command center owner (Constitution v1.1, L13).
// Halaman pertama yang dibuka owner setiap pagi; target: paham kondisi bisnis
// < 30 detik. Semua angka utama datang dari Executive Service Layer — modul
// baru cukup mendaftarkan contributor, halaman ini tidak berubah.
// =============================================================================

function formatIDR(amount: number) {
  if (amount >= 1_000_000_000) return `Rp${(amount / 1_000_000_000).toFixed(2)}M`;
  if (amount >= 1_000_000) return `Rp${(amount / 1_000_000).toFixed(1)}Jt`;
  if (amount >= 1_000) return `Rp${(amount / 1_000).toFixed(0)}Rb`;
  return `Rp${amount.toLocaleString("id-ID")}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 18) return "Selamat sore";
  return "Selamat malam";
}

function getTodayLabel() {
  return new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const RING_TONE = {
  green: { score: "text-green-400", ring: "stroke-green-400", badge: "bg-green-100 text-green-800" },
  blue: { score: "text-blue-300", ring: "stroke-blue-400", badge: "bg-blue-100 text-blue-800" },
  amber: { score: "text-amber-400", ring: "stroke-amber-400", badge: "bg-amber-100 text-amber-800" },
  red: { score: "text-red-400", ring: "stroke-red-400", badge: "bg-red-100 text-red-800" },
} as const;

export default async function ExecutiveIntelligencePage() {
  const user = await getAuthUser();

  if (!user.roles.includes("owner") && !user.roles.includes("super_admin")) {
    redirect("/dashboard");
  }

  const [overview, salesKpiPerformance, data] = await Promise.all([
    getExecutiveOverview(user.company_id),
    getOwnerSalesKpiPerformance(user.company_id),
    fetchOwnerDashboardData(user.company_id),
  ]);

  const tone = RING_TONE[overview.health.tone];

  const orderColumns = [
    {
      key: "order_number",
      label: "No. Order",
      render: (row: RecentOrder) => (
        <span className="font-mono text-xs font-medium text-gray-900">{row.order_number}</span>
      ),
    },
    {
      key: "customer_name",
      label: "Pelanggan",
      render: (row: RecentOrder) => <span className="text-gray-900">{row.customer_name}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (row: RecentOrder) => <StatusBadge status={row.status} />,
    },
    {
      key: "final_amount",
      label: "Total",
      align: "right" as const,
      render: (row: RecentOrder) => <span className="font-semibold">{formatIDR(row.final_amount)}</span>,
    },
    {
      key: "created_at",
      label: "Tanggal",
      align: "right" as const,
      render: (row: RecentOrder) => <span className="text-xs text-gray-400">{formatDate(row.created_at)}</span>,
    },
  ];

  const followUpColumns = [
    {
      key: "name",
      label: "Pelanggan",
      render: (row: FollowUpCustomer) => (
        <div>
          <p className="font-medium text-gray-900">{row.name}</p>
          <p className="text-xs text-gray-400">{row.code} · {row.area}</p>
        </div>
      ),
    },
    {
      key: "sales_name",
      label: "Sales PIC",
      render: (row: FollowUpCustomer) => <span className="text-gray-600">{row.sales_name}</span>,
    },
    {
      key: "days_inactive",
      label: "Tidak Aktif",
      align: "right" as const,
      render: (row: FollowUpCustomer) => (
        <span className={`font-semibold ${
          row.days_inactive > 60 ? "text-red-600" : row.days_inactive > 45 ? "text-amber-600" : "text-gray-600"
        }`}>
          {row.days_inactive > 900 ? "Belum pernah order" : `${row.days_inactive} hari`}
        </span>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">

      {/* ════════════════════════════════════════════════════ */}
      {/* HERO — sapaan + Business Health ring + aksi cepat    */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-700 p-6 text-white shadow-lg">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 -left-8 h-40 w-40 rounded-full bg-white/5" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-200" />
              <span className="text-sm text-blue-200">{getTodayLabel()}</span>
            </div>
            <h1 className="text-2xl font-bold">{getGreeting()}, Owner</h1>
            <p className="mt-0.5 text-blue-200">{user.company.name}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${tone.badge}`}>
                <Activity className="h-3.5 w-3.5" />
                {overview.health.label}
              </span>
              {overview.actions.length > 0 ? (
                <Link
                  href="#aksi-direkomendasikan"
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-white/20"
                >
                  {overview.insights.length} insight · {overview.actions.length} tindakan direkomendasikan →
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">
                  {overview.insights.length} insight · {overview.actions.length} tindakan direkomendasikan
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col items-center">
            <div className="relative flex h-28 w-28 items-center justify-center">
              <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="42" fill="none"
                  className={tone.ring}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(overview.health.score / 100) * 263.9} 263.9`}
                />
              </svg>
              <div className="text-center">
                <p className={`text-3xl font-black ${tone.score}`}>{overview.health.score}</p>
                <p className="text-xs font-medium text-blue-200">/100</p>
              </div>
            </div>
            <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-blue-100">Business Health</p>
          </div>

          <div className="flex flex-col gap-2 lg:items-end">
            <p className="text-xs font-medium uppercase tracking-wide text-blue-200">Aksi Cepat</p>
            <div className="grid grid-cols-2 gap-2">
              <Link href="/dashboard/risk"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20">
                <ShieldAlert className="h-3.5 w-3.5" /> Risk Alert
              </Link>
              <Link href="/dashboard/users"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20">
                <Users className="h-3.5 w-3.5" /> Kelola Pengguna
              </Link>
              <Link href="/dashboard/reports"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20">
                <FileText className="h-3.5 w-3.5" /> Laporan Sales
              </Link>
              <Link href="/dashboard/settings"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/20">
                <Settings className="h-3.5 w-3.5" /> Pengaturan
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* 30 DETIK PERTAMA — briefing + tindakan               */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BriefingCard briefing={overview.briefing} />
        <div id="aksi-direkomendasikan" className="scroll-mt-6">
          <ActionsCard actions={overview.actions} />
        </div>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* HEALTH BREAKDOWN + KPI                               */}
      {/* ════════════════════════════════════════════════════ */}
      <BusinessHealthCard health={overview.health} modules={overview.modules} />
      <KpiGrid kpis={overview.kpis} />

      {/* ════════════════════════════════════════════════════ */}
      {/* PERFORMA SALES + ORDER TERBARU                       */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SalesPerformanceCard
          rows={salesKpiPerformance.rows}
          periodActive={salesKpiPerformance.periodActive}
          periodName={salesKpiPerformance.periodName}
        />
        <ChartCard
          title="Order Terbaru"
          description="10 transaksi terakhir"
          action={
            <Link href="/dashboard/orders" className="text-xs font-medium text-blue-600 hover:text-blue-700">
              Lihat semua →
            </Link>
          }
        >
          {data.recentOrders.length > 0 ? (
            <DataTable<RecentOrder>
              columns={orderColumns}
              data={data.recentOrders}
              keyExtractor={(r) => r.id}
              emptyTitle="Belum ada order"
              compact
            />
          ) : (
            <EmptyState
              icon={<ShoppingCart className="h-6 w-6" />}
              title="Belum ada order"
              description="Buat order pertama untuk memulai"
            />
          )}
        </ChartCard>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* TREN + FOLLOW UP (preview Customer Health)           */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="Tren Revenue & Order"
          description="6 bulan terakhir"
          className="lg:col-span-2"
        >
          {data.monthlyRevenue.length > 0 ? (
            <RevenueTrendChart data={data.monthlyRevenue} />
          ) : (
            <EmptyState
              icon={<TrendingUp className="h-6 w-6" />}
              title="Belum ada data revenue"
              description="Data muncul setelah ada order terkonfirmasi"
            />
          )}
        </ChartCard>

        <ChartCard
          title="Performa Area"
          description="Top area berdasarkan jumlah order"
        >
          {data.areaPerformance.length > 0 ? (
            <AreaPerformanceChart data={data.areaPerformance} />
          ) : (
            <EmptyState
              icon={<Activity className="h-6 w-6" />}
              title="Belum ada data area"
              description="Tambahkan area pada profil pelanggan"
            />
          )}
        </ChartCard>
      </div>

      <ChartCard
        title="Perlu Follow Up"
        description="Pelanggan tidak aktif >45 hari — pratinjau sinyal Customer Health (modul menyusul)"
        action={
          data.followUpCustomers.length > 0 ? (
            <span className="flex items-center gap-1 text-xs font-medium text-red-500">
              <Clock className="h-3.5 w-3.5" />
              {data.followUpCustomers.length} pelanggan
            </span>
          ) : undefined
        }
      >
        {data.followUpCustomers.length > 0 ? (
          <DataTable<FollowUpCustomer>
            columns={followUpColumns}
            data={data.followUpCustomers}
            keyExtractor={(r) => r.id}
            emptyTitle="Semua pelanggan aktif"
            compact
          />
        ) : (
          <EmptyState
            icon={<CheckCircle2 className="h-6 w-6 text-green-500" />}
            title="Semua pelanggan aktif"
            description="Tidak ada pelanggan yang melewati batas 45 hari."
          />
        )}
      </ChartCard>

    </div>
  );
}
