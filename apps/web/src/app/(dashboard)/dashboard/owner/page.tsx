import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { fetchOwnerDashboardData } from "@/lib/dashboard/owner-metrics";
import { KpiCard } from "@/components/ui/kpi-card";
import { ChartCard } from "@/components/ui/chart-card";
import { AiInsightCard } from "@/components/ui/ai-insight-card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/dashboard/status-badge";
import {
  RevenueTrendChart,
  AreaPerformanceChart,
  ForecastChart,
} from "@/components/dashboard/revenue-chart";
import {
  TrendingUp,
  TrendingDown,
  Users,
  ShoppingCart,
  AlertCircle,
  RefreshCw,
  Clock,
  Plus,
  UserPlus,
  Upload,
  Zap,
  Activity,
  Brain,
  Calendar,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import Link from "next/link";
import type { SalesPerformance, RecentOrder, FollowUpCustomer } from "@/lib/dashboard/owner-metrics";

export const metadata = { title: "Executive Dashboard — AODP" };

function formatIDR(amount: number) {
  if (amount >= 1_000_000_000)
    return `Rp${(amount / 1_000_000_000).toFixed(2)}M`;
  if (amount >= 1_000_000) return `Rp${(amount / 1_000_000).toFixed(1)}Jt`;
  if (amount >= 1_000) return `Rp${(amount / 1_000).toFixed(0)}Rb`;
  return `Rp${amount.toLocaleString("id-ID")}`;
}

function formatIDRFull(amount: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 18) return "Selamat sore";
  return "Selamat malam";
}

function getTodayLabel() {
  return new Date().toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default async function OwnerDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("owner") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const data = await fetchOwnerDashboardData(user.company_id);

  // ── Business Health Score ──
  const activeRate = data.totalResellers > 0 ? data.activeResellers / data.totalResellers : 0;
  const dormantPenalty = data.totalResellers > 0 ? data.dormantResellers / data.totalResellers : 0;

  const healthScore = Math.min(100, Math.max(0, Math.round(
    activeRate * 40 +
    (data.repeatOrderRate / 100) * 30 +
    (data.forecastGrowthRate > 5 ? 20 : data.forecastGrowthRate > 0 ? 15 : data.forecastGrowthRate === 0 ? 10 : 5) +
    Math.max(0, 10 - dormantPenalty * 20)
  )));

  const healthConfig =
    healthScore >= 80
      ? { label: "Bisnis Sangat Sehat", badgeCls: "bg-green-100 text-green-800", scoreCls: "text-green-400", ringCls: "stroke-green-400" }
      : healthScore >= 65
      ? { label: "Performa Baik", badgeCls: "bg-blue-100 text-blue-800", scoreCls: "text-blue-300", ringCls: "stroke-blue-400" }
      : healthScore >= 50
      ? { label: "Perlu Optimasi", badgeCls: "bg-amber-100 text-amber-800", scoreCls: "text-amber-400", ringCls: "stroke-amber-400" }
      : { label: "Perlu Tindakan Segera", badgeCls: "bg-red-100 text-red-800", scoreCls: "text-red-400", ringCls: "stroke-red-400" };

  // ── Forecast trend ──
  const forecastTrend =
    data.forecastGrowthRate > 0 ? "up" : data.forecastGrowthRate < 0 ? "down" : "neutral";

  const forecastLabel =
    data.forecastGrowthRate > 0
      ? `+${data.forecastGrowthRate}% proyeksi bulan depan`
      : data.forecastGrowthRate < 0
      ? `${data.forecastGrowthRate}% proyeksi bulan depan`
      : "Stabil";

  // ── Top priority alert ──
  const topPriorityCustomer = data.followUpCustomers[0] ?? null;

  // ── Tables ──
  const salesColumns = [
    {
      key: "sales_name",
      label: "Nama Sales",
      render: (row: SalesPerformance) => (
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
            {(row.sales_name ?? "?").charAt(0).toUpperCase()}
          </div>
          <span className="font-medium text-gray-900">{row.sales_name}</span>
        </div>
      ),
    },
    {
      key: "order_count",
      label: "Order",
      align: "right" as const,
      render: (row: SalesPerformance) => (
        <span className="font-medium">{row.order_count.toLocaleString("id-ID")}</span>
      ),
    },
    {
      key: "customer_count",
      label: "Reseller",
      align: "right" as const,
      render: (row: SalesPerformance) => (
        <span>{row.customer_count.toLocaleString("id-ID")}</span>
      ),
    },
    {
      key: "revenue",
      label: "Revenue",
      align: "right" as const,
      render: (row: SalesPerformance) => (
        <span className="font-semibold text-gray-900">{formatIDR(row.revenue)}</span>
      ),
    },
  ];

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
      label: "Reseller",
      render: (row: RecentOrder) => (
        <span className="text-gray-900">{row.customer_name}</span>
      ),
    },
    {
      key: "sales_name",
      label: "Sales",
      render: (row: RecentOrder) => (
        <span className="text-gray-500">{row.sales_name}</span>
      ),
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
      render: (row: RecentOrder) => (
        <span className="font-semibold">{formatIDR(row.final_amount)}</span>
      ),
    },
    {
      key: "created_at",
      label: "Tanggal",
      align: "right" as const,
      render: (row: RecentOrder) => (
        <span className="text-gray-400 text-xs">{formatDate(row.created_at)}</span>
      ),
    },
  ];

  const followUpColumns = [
    {
      key: "name",
      label: "Reseller",
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
      render: (row: FollowUpCustomer) => (
        <span className="text-gray-600">{row.sales_name}</span>
      ),
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
    {
      key: "last_order_at",
      label: "Order Terakhir",
      align: "right" as const,
      render: (row: FollowUpCustomer) => (
        <span className="text-xs text-gray-400">
          {row.last_order_at ? formatDate(row.last_order_at) : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 1 — Executive Hero Banner                  */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-700 via-blue-600 to-indigo-700 p-6 text-white shadow-lg">
        {/* Background decoration */}
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 -left-8 h-40 w-40 rounded-full bg-white/5" />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          {/* Left: Greeting */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Calendar className="h-4 w-4 text-blue-200" />
              <span className="text-sm text-blue-200">{getTodayLabel()}</span>
            </div>
            <h1 className="text-2xl font-bold">{getGreeting()}, Owner</h1>
            <p className="mt-0.5 text-blue-200">{user.company.name}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${healthConfig.badgeCls}`}>
                <Activity className="h-3.5 w-3.5" />
                {healthConfig.label}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">
                <Brain className="h-3.5 w-3.5" />
                {data.aiAlerts.length} AI Insight Aktif
              </span>
            </div>
          </div>

          {/* Center: Health Score */}
          <div className="flex flex-col items-center">
            <div className="relative flex h-28 w-28 items-center justify-center">
              <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="42" fill="none"
                  className={healthConfig.ringCls}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={`${(healthScore / 100) * 263.9} 263.9`}
                />
              </svg>
              <div className="text-center">
                <p className={`text-3xl font-black ${healthConfig.scoreCls}`}>{healthScore}</p>
                <p className="text-xs text-blue-200 font-medium">/100</p>
              </div>
            </div>
            <p className="mt-1 text-xs font-semibold text-blue-100 uppercase tracking-widest">Health Score</p>
          </div>

          {/* Right: Quick Actions */}
          <div className="flex flex-col gap-2 lg:items-end">
            <p className="text-xs text-blue-200 font-medium uppercase tracking-wide">Aksi Cepat</p>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/dashboard/orders/new"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                Buat Order
              </Link>
              <Link
                href="/dashboard/customers/new"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Reseller Baru
              </Link>
              <Link
                href="/dashboard/settings/import"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                <Upload className="h-3.5 w-3.5" />
                Import Data
              </Link>
              <Link
                href="/dashboard/automation"
                className="flex items-center gap-1.5 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-white hover:bg-white/20 transition-colors"
              >
                <Zap className="h-3.5 w-3.5" />
                Automation
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 2 — Business Health Score Detail Card      */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
            <Activity className="h-4 w-4 text-blue-600" />
          </div>
          <h2 className="text-sm font-semibold text-gray-900">Business Health Score — Breakdown</h2>
          <span className={`ml-auto inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${healthConfig.badgeCls}`}>
            {healthScore}/100 · {healthConfig.label}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/* Active Rate */}
          <div className="rounded-xl bg-green-50 border border-green-100 p-3">
            <p className="text-xs text-green-600 font-medium">Reseller Aktif</p>
            <p className="mt-1 text-xl font-bold text-green-700">{Math.round(activeRate * 100)}%</p>
            <p className="mt-0.5 text-xs text-green-600">
              {data.activeResellers}/{data.totalResellers} reseller
            </p>
            <div className="mt-2 h-1.5 rounded-full bg-green-100">
              <div className="h-1.5 rounded-full bg-green-500" style={{ width: `${Math.round(activeRate * 100)}%` }} />
            </div>
          </div>

          {/* Repeat Order */}
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-3">
            <p className="text-xs text-blue-600 font-medium">Repeat Order Rate</p>
            <p className="mt-1 text-xl font-bold text-blue-700">{data.repeatOrderRate}%</p>
            <p className="mt-0.5 text-xs text-blue-600">tingkat loyalitas</p>
            <div className="mt-2 h-1.5 rounded-full bg-blue-100">
              <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${data.repeatOrderRate}%` }} />
            </div>
          </div>

          {/* Growth Forecast */}
          <div className={`rounded-xl border p-3 ${data.forecastGrowthRate >= 0 ? "bg-purple-50 border-purple-100" : "bg-red-50 border-red-100"}`}>
            <p className={`text-xs font-medium ${data.forecastGrowthRate >= 0 ? "text-purple-600" : "text-red-600"}`}>Tren Forecast</p>
            <p className={`mt-1 text-xl font-bold ${data.forecastGrowthRate >= 0 ? "text-purple-700" : "text-red-700"}`}>
              {data.forecastGrowthRate > 0 ? "+" : ""}{data.forecastGrowthRate}%
            </p>
            <p className={`mt-0.5 text-xs ${data.forecastGrowthRate >= 0 ? "text-purple-600" : "text-red-600"}`}>proyeksi bulan depan</p>
            <div className="mt-2 h-1.5 rounded-full bg-gray-200">
              <div
                className={`h-1.5 rounded-full ${data.forecastGrowthRate >= 0 ? "bg-purple-500" : "bg-red-500"}`}
                style={{ width: `${Math.min(100, Math.abs(data.forecastGrowthRate) * 5)}%` }}
              />
            </div>
          </div>

          {/* Dormant Risk */}
          <div className={`rounded-xl border p-3 ${dormantPenalty > 0.3 ? "bg-red-50 border-red-100" : "bg-amber-50 border-amber-100"}`}>
            <p className={`text-xs font-medium ${dormantPenalty > 0.3 ? "text-red-600" : "text-amber-600"}`}>Risiko Dormant</p>
            <p className={`mt-1 text-xl font-bold ${dormantPenalty > 0.3 ? "text-red-700" : "text-amber-700"}`}>{data.dormantResellers}</p>
            <p className={`mt-0.5 text-xs ${dormantPenalty > 0.3 ? "text-red-600" : "text-amber-600"}`}>
              {Math.round(dormantPenalty * 100)}% dari total
            </p>
            <div className="mt-2 h-1.5 rounded-full bg-gray-200">
              <div
                className={`h-1.5 rounded-full ${dormantPenalty > 0.3 ? "bg-red-500" : "bg-amber-500"}`}
                style={{ width: `${Math.min(100, Math.round(dormantPenalty * 100))}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 3 — Executive KPI Cards (6 cards)          */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label="Revenue Hari Ini"
          value={formatIDR(data.revenueToday)}
          subValue={data.revenueToday > 0 ? formatIDRFull(data.revenueToday) : "Belum ada order hari ini"}
          accent="green"
          icon={<TrendingUp className="h-4 w-4" />}
          trend={data.revenueToday > 0 ? "up" : "neutral"}
          trendLabel={data.revenueToday > 0 ? "Order masuk hari ini" : "Pantau perkembangan"}
        />
        <KpiCard
          label="Revenue Bulan Ini"
          value={formatIDR(data.revenueThisMonth)}
          subValue={formatIDRFull(data.revenueThisMonth)}
          accent="blue"
          icon={<Activity className="h-4 w-4" />}
          trend={forecastTrend}
          trendLabel={forecastLabel}
        />
        <KpiCard
          label="Order Bulan Ini"
          value={data.ordersThisMonth.toLocaleString("id-ID")}
          subValue={`Dari ${data.totalOrders6Months.toLocaleString("id-ID")} total 6 bulan`}
          accent="indigo"
          icon={<ShoppingCart className="h-4 w-4" />}
          trend={data.ordersThisMonth > 0 ? "up" : "neutral"}
          trendLabel={`${data.ordersThisMonth} order bulan ini`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label="Reseller Aktif"
          value={data.activeResellers.toLocaleString("id-ID")}
          subValue={`${Math.round(activeRate * 100)}% dari ${data.totalResellers} total reseller`}
          accent="green"
          trend="up"
          trendLabel={`${data.activeResellers} aktif 30 hari terakhir`}
          icon={<Users className="h-4 w-4" />}
        />
        <KpiCard
          label="Reseller Berisiko Churn"
          value={data.dormantResellers.toLocaleString("id-ID")}
          subValue="Tidak order lebih dari 30 hari"
          accent={data.dormantResellers > 20 ? "red" : "amber"}
          trend={data.dormantResellers > 20 ? "down" : "neutral"}
          trendLabel={`${data.dormantResellers} perlu follow up segera`}
          icon={<AlertCircle className="h-4 w-4" />}
        />
        <KpiCard
          label="Repeat Order Rate"
          value={`${data.repeatOrderRate}%`}
          subValue={`Dari ${data.totalOrders6Months.toLocaleString("id-ID")} total order 6 bulan`}
          accent={data.repeatOrderRate >= 70 ? "green" : data.repeatOrderRate >= 50 ? "blue" : "amber"}
          trend={data.repeatOrderRate >= 70 ? "up" : "neutral"}
          trendLabel={data.repeatOrderRate >= 70 ? "Loyalitas reseller tinggi" : "Tingkatkan program loyalitas"}
          icon={<RefreshCw className="h-4 w-4" />}
        />
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 4 — Smart Alert Panel                      */}
      {/* ════════════════════════════════════════════════════ */}
      {topPriorityCustomer ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-bold text-red-900">Prioritas Tertinggi — Perlu Tindakan Segera</p>
                <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 border border-red-200">
                  {topPriorityCustomer.days_inactive > 900 ? "Belum pernah order" : `${topPriorityCustomer.days_inactive} hari tidak aktif`}
                </span>
              </div>
              <p className="mt-1 text-sm font-semibold text-red-800">
                {topPriorityCustomer.name}
                <span className="ml-2 text-xs font-normal text-red-600">
                  {topPriorityCustomer.code} · {topPriorityCustomer.area}
                </span>
              </p>
              <div className="mt-2 flex items-center gap-4 text-xs text-red-700">
                <span className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  Sales PIC: <strong className="ml-1">{topPriorityCustomer.sales_name}</strong>
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  Order terakhir: {topPriorityCustomer.last_order_at ? formatDate(topPriorityCustomer.last_order_at) : "Tidak ada"}
                </span>
                {data.followUpCustomers.length > 1 && (
                  <span className="text-red-500 font-medium">
                    +{data.followUpCustomers.length - 1} reseller lainnya perlu follow up
                  </span>
                )}
              </div>
            </div>
            <Link
              href="/dashboard/customers"
              className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
            >
              Lihat Semua
            </Link>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-green-100">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-green-800">Semua Reseller Aktif</p>
              <p className="text-xs text-green-700">Tidak ada reseller yang perlu follow up segera. Pertahankan performa ini!</p>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 5 — AI Executive Briefing                  */}
      {/* ════════════════════════════════════════════════════ */}
      {data.aiAlerts.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-50">
                <Brain className="h-4 w-4 text-purple-600" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900">AI Executive Briefing</h3>
                <p className="text-xs text-gray-500">Analisis cerdas berdasarkan data transaksi terkini</p>
              </div>
            </div>
            <span className="inline-flex items-center rounded-full bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700 border border-purple-100">
              {data.aiAlerts.length} insight ditemukan
            </span>
          </div>
          <div className="p-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.aiAlerts.map((alert, i) => (
              <AiInsightCard key={i} {...alert} />
            ))}
          </div>
          <div className="border-t border-gray-100 px-5 py-3">
            <Link
              href="/dashboard/ai"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-purple-600 hover:text-purple-700"
            >
              <Brain className="h-3.5 w-3.5" />
              Lihat AI Intelligence lengkap dengan prediksi churn &amp; repeat order
            </Link>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 6 — Charts                                 */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard
          title="Tren Revenue & Order"
          description="6 bulan terakhir (Jan – Jun 2026)"
          badge="Live"
          className="lg:col-span-2"
        >
          {data.monthlyRevenue.length > 0 ? (
            <RevenueTrendChart data={data.monthlyRevenue} />
          ) : (
            <EmptyState
              icon={<TrendingUp className="h-6 w-6" />}
              title="Belum ada data revenue"
              description="Data akan muncul setelah ada order yang dikonfirmasi"
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
              description="Tambahkan area pada profil reseller Anda"
            />
          )}
        </ChartCard>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 7 — Sales Performance + Recent Orders      */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Performa Sales"
          description="Revenue dan order per sales rep (6 bulan)"
        >
          {data.salesPerformance.length > 0 ? (
            <DataTable<SalesPerformance>
              columns={salesColumns}
              data={data.salesPerformance}
              keyExtractor={(r) => r.sales_id}
              emptyTitle="Belum ada data sales"
              compact
            />
          ) : (
            <EmptyState
              icon={<Users className="h-6 w-6" />}
              title="Belum ada data performa sales"
              description="Data akan muncul setelah ada order dengan sales PIC"
            />
          )}
        </ChartCard>

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
              action={
                <Link
                  href="/dashboard/orders/new"
                  className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Buat Order Pertama
                </Link>
              }
            />
          )}
        </ChartCard>
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* SECTION 8 — Follow Up + Forecast                   */}
      {/* ════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Perlu Follow Up"
          description="Reseller tidak aktif lebih dari 45 hari (risiko churn tertinggi)"
          action={
            data.followUpCustomers.length > 0 ? (
              <span className="flex items-center gap-1 text-xs text-red-500 font-medium">
                <Clock className="h-3.5 w-3.5" />
                {data.followUpCustomers.length} reseller
              </span>
            ) : undefined
          }
        >
          {data.followUpCustomers.length > 0 ? (
            <DataTable<FollowUpCustomer>
              columns={followUpColumns}
              data={data.followUpCustomers}
              keyExtractor={(r) => r.id}
              emptyTitle="Semua reseller aktif"
              emptyDescription="Tidak ada reseller yang perlu follow up"
              compact
            />
          ) : (
            <EmptyState
              icon={<CheckCircle2 className="h-6 w-6 text-green-500" />}
              title="Semua reseller aktif!"
              description="Tidak ada reseller yang melewati batas 45 hari. Performa sangat baik."
            />
          )}
        </ChartCard>

        <ChartCard
          title="Forecast Revenue Bulan Depan"
          description="Proyeksi Jul 2026 berdasarkan tren linear 6 bulan"
        >
          <div className="mb-4 flex items-center gap-4 flex-wrap">
            <div>
              <p className="text-xs text-gray-500">Proyeksi Jul 2026</p>
              <p className="text-2xl font-bold text-purple-700">
                {formatIDR(data.forecastNextMonth)}
              </p>
            </div>
            <div
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                forecastTrend === "up"
                  ? "bg-green-50 text-green-700"
                  : forecastTrend === "down"
                  ? "bg-red-50 text-red-700"
                  : "bg-gray-50 text-gray-700"
              }`}
            >
              {forecastTrend === "up"
                ? <TrendingUp className="h-3.5 w-3.5" />
                : forecastTrend === "down"
                ? <TrendingDown className="h-3.5 w-3.5" />
                : null}
              {forecastTrend === "up" ? `+${data.forecastGrowthRate}%` : forecastTrend === "down" ? `${data.forecastGrowthRate}%` : "Stabil"} vs bulan ini
            </div>
          </div>
          {data.monthlyRevenue.length > 0 ? (
            <ForecastChart
              historicalData={data.monthlyRevenue}
              forecastValue={data.forecastNextMonth}
            />
          ) : (
            <EmptyState
              icon={<TrendingUp className="h-6 w-6" />}
              title="Data tidak cukup untuk forecast"
              description="Butuh minimal 2 bulan data untuk membuat proyeksi"
            />
          )}
          <p className="mt-2 text-xs text-gray-400">
            * Proyeksi menggunakan regresi linear. Untuk AI Forecast lanjutan, lihat halaman AI Intelligence.
          </p>
        </ChartCard>
      </div>

    </div>
  );
}
