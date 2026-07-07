import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { generateAllInsights } from "@/lib/ai/insights-engine";
import { PageHeader } from "@/components/ui/page-header";
import { ChartCard } from "@/components/ui/chart-card";
import { AiInsightCard } from "@/components/ui/ai-insight-card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Brain,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import type { ChurnPredictionResult } from "@/lib/ai/features/churn-prediction";
import type { RepeatOrderPrediction } from "@/lib/ai/features/repeat-order-prediction";

export const metadata = { title: "AI Intelligence — AODP" };

const RISK_STYLE: Record<string, { label: string; className: string }> = {
  HIGH:   { label: "Tinggi",   className: "bg-red-100 text-red-700 font-semibold" },
  MEDIUM: { label: "Sedang",   className: "bg-amber-100 text-amber-700" },
  LOW:    { label: "Rendah",   className: "bg-blue-100 text-blue-700" },
  NONE:   { label: "Aman",     className: "bg-green-100 text-green-700" },
};

function RiskBadge({ level }: { level: string }) {
  const s = RISK_STYLE[level] ?? RISK_STYLE["NONE"]!;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${s.className}`}>
      {s.label}
    </span>
  );
}

function formatIDR(amount: number) {
  if (amount >= 1_000_000_000) return `Rp${(amount / 1_000_000_000).toFixed(1)}M`;
  if (amount >= 1_000_000) return `Rp${(amount / 1_000_000).toFixed(1)}Jt`;
  if (amount >= 1_000) return `Rp${(amount / 1_000).toFixed(0)}Rb`;
  return `Rp${amount.toLocaleString("id-ID")}`;
}

function formatDate(iso: string | null) {
  if (!iso) return "Belum pernah";
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

const RATING_CONFIG = {
  excellent:       { label: "Luar Biasa",   icon: "🏆", className: "bg-green-50 border-green-200 text-green-800" },
  good:            { label: "Baik",         icon: "✅", className: "bg-blue-50 border-blue-200 text-blue-800" },
  average:         { label: "Rata-rata",    icon: "📊", className: "bg-gray-50 border-gray-200 text-gray-800" },
  needs_attention: { label: "Perlu Perhatian", icon: "⚠️", className: "bg-amber-50 border-amber-200 text-amber-800" },
  critical:        { label: "Kritis",       icon: "🚨", className: "bg-red-50 border-red-200 text-red-800" },
};

export default async function AiDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("owner") &&
    !user.roles.includes("manager") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const insights = await generateAllInsights(user.company_id);
  const { churn_predictions, repeat_order_predictions, revenue_forecast, executive_summary } = insights;

  const highRisk = churn_predictions.filter((p) => p.risk_level === "HIGH");
  const mediumRisk = churn_predictions.filter((p) => p.risk_level === "MEDIUM");
  const overdue = repeat_order_predictions.filter((p) => p.is_overdue);
  const dueThisWeek = repeat_order_predictions.filter((p) => !p.is_overdue && p.days_until_next_order <= 7);

  const ratingCfg = RATING_CONFIG[executive_summary.performance_rating];

  // Churn table columns
  const churnColumns = [
    {
      key: "name",
      label: "Reseller",
      render: (r: ChurnPredictionResult) => (
        <div>
          <p className="font-medium text-gray-900">{r.customer_name}</p>
          <p className="text-xs text-gray-400">{r.total_orders} order · {formatIDR(r.total_revenue)}</p>
        </div>
      ),
    },
    {
      key: "risk",
      label: "Risiko Churn",
      render: (r: ChurnPredictionResult) => <RiskBadge level={r.risk_level} />,
    },
    {
      key: "inactive",
      label: "Tidak Aktif",
      align: "right" as const,
      render: (r: ChurnPredictionResult) => (
        <span className={`font-semibold text-sm ${r.risk_level === "HIGH" ? "text-red-600" : r.risk_level === "MEDIUM" ? "text-amber-600" : "text-gray-600"}`}>
          {r.days_since_last_order < 0 ? "Belum order" : `${r.days_since_last_order} hari`}
        </span>
      ),
    },
    {
      key: "confidence",
      label: "Akurasi AI",
      align: "right" as const,
      render: (r: ChurnPredictionResult) => (
        <span className="text-xs text-gray-500">{Math.round(r.confidence * 100)}%</span>
      ),
    },
    {
      key: "recommendation",
      label: "Rekomendasi",
      render: (r: ChurnPredictionResult) => (
        <span className="text-xs text-gray-600 max-w-xs truncate block">{r.recommendation}</span>
      ),
    },
  ];

  // Repeat order columns
  const repeatColumns = [
    {
      key: "name",
      label: "Reseller",
      render: (r: RepeatOrderPrediction) => (
        <div>
          <p className="font-medium text-gray-900">{r.customer_name}</p>
          <p className="text-xs text-gray-400">Interval: ~{r.avg_interval_days} hari</p>
        </div>
      ),
    },
    {
      key: "last_order",
      label: "Order Terakhir",
      render: (r: RepeatOrderPrediction) => (
        <span className="text-sm text-gray-600">{formatDate(r.last_order_at)}</span>
      ),
    },
    {
      key: "predicted",
      label: "Prediksi Order Berikutnya",
      render: (r: RepeatOrderPrediction) => (
        <span className="text-sm text-gray-900">
          {r.predicted_next_order_at ? formatDate(r.predicted_next_order_at) : "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      align: "right" as const,
      render: (r: RepeatOrderPrediction) => (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
          r.is_overdue ? "bg-red-100 text-red-700" : r.days_until_next_order <= 3 ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
        }`}>
          {r.is_overdue ? `Terlambat ${Math.abs(r.days_until_next_order)} hari` : `${r.days_until_next_order} hari lagi`}
        </span>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="AI Intelligence"
        subtitle="Analisis cerdas berbasis data nyata — 5 fitur AI untuk keputusan bisnis lebih baik"
      >
        <div className="flex items-center gap-2 rounded-full bg-purple-50 border border-purple-200 px-3 py-1.5">
          <Brain className="h-4 w-4 text-purple-600" />
          <span className="text-xs font-medium text-purple-700">Rule-Based AI · Real Data</span>
        </div>
      </PageHeader>

      {/* Executive Summary */}
      <div className={`rounded-xl border-2 p-5 ${ratingCfg.className}`}>
        <div className="flex items-start gap-3">
          <span className="text-2xl">{ratingCfg.icon}</span>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="font-bold text-base">{executive_summary.headline}</p>
              <span className="text-xs font-medium rounded-full bg-white/60 px-2 py-0.5 border">
                {ratingCfg.label}
              </span>
            </div>
            <p className="text-sm leading-relaxed">{executive_summary.overall_insight}</p>
          </div>
        </div>
      </div>

      {/* Key Actions */}
      {executive_summary.key_actions.length > 0 && (
        <ChartCard
          title="Rekomendasi Tindakan"
          description="AI merekomendasikan tindakan berikut berdasarkan analisis data"
          badge={`${executive_summary.key_actions.length} aksi`}
        >
          <div className="space-y-3">
            {executive_summary.key_actions.map((action, i) => (
              <AiInsightCard
                key={i}
                type={action.priority === "URGENT" ? "alert" : action.priority === "HIGH" ? "warning" : "opportunity"}
                title={`[${action.priority}] ${action.action}`}
                message={action.rationale}
                metric={action.expected_impact}
              />
            ))}
          </div>
        </ChartCard>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-lg bg-red-50 p-1.5"><AlertTriangle className="h-4 w-4 text-red-600" /></div>
            <span className="text-xs text-gray-500">Churn Risk Tinggi</span>
          </div>
          <p className="text-2xl font-bold text-red-600">{highRisk.length}</p>
          <p className="text-xs text-gray-500 mt-1">reseller perlu tindakan segera</p>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-lg bg-amber-50 p-1.5"><AlertTriangle className="h-4 w-4 text-amber-600" /></div>
            <span className="text-xs text-gray-500">Churn Risk Sedang</span>
          </div>
          <p className="text-2xl font-bold text-amber-600">{mediumRisk.length}</p>
          <p className="text-xs text-gray-500 mt-1">reseller perlu follow up</p>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-lg bg-blue-50 p-1.5"><ShoppingCart className="h-4 w-4 text-blue-600" /></div>
            <span className="text-xs text-gray-500">Repeat Order Overdue</span>
          </div>
          <p className="text-2xl font-bold text-blue-600">{overdue.length}</p>
          <p className="text-xs text-gray-500 mt-1">melewati estimasi order</p>
        </div>

        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="rounded-lg bg-green-50 p-1.5"><TrendingUp className="h-4 w-4 text-green-600" /></div>
            <span className="text-xs text-gray-500">Order Jatuh Tempo Minggu Ini</span>
          </div>
          <p className="text-2xl font-bold text-green-600">{dueThisWeek.length}</p>
          <p className="text-xs text-gray-500 mt-1">perlu disiapkan</p>
        </div>
      </div>

      {/* Forecast Section */}
      <ChartCard
        title="AI Revenue Forecast"
        description={`Proyeksi ${revenue_forecast.forecast_month_label} menggunakan regresi linear`}
        badge={`R² ${Math.round(revenue_forecast.r_squared * 100)}%`}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-purple-50 border border-purple-100 p-4">
            <p className="text-xs text-purple-600 font-medium mb-1">Proyeksi {revenue_forecast.forecast_month_label}</p>
            <p className="text-2xl font-bold text-purple-700">{formatIDR(revenue_forecast.predicted_revenue)}</p>
            <div className={`flex items-center gap-1 mt-2 text-xs font-medium ${revenue_forecast.growth_rate_pct >= 0 ? "text-green-600" : "text-red-600"}`}>
              {revenue_forecast.growth_rate_pct >= 0
                ? <TrendingUp className="h-3.5 w-3.5" />
                : <TrendingDown className="h-3.5 w-3.5" />}
              {revenue_forecast.growth_rate_pct > 0 ? "+" : ""}{revenue_forecast.growth_rate_pct}% dari bulan ini
            </div>
          </div>
          <div className="rounded-xl bg-gray-50 border p-4">
            <p className="text-xs text-gray-500 mb-1">Batas Bawah (80% CI)</p>
            <p className="text-xl font-bold text-gray-700">{formatIDR(revenue_forecast.lower_bound)}</p>
            <p className="text-xs text-gray-400 mt-2">Skenario konservatif</p>
          </div>
          <div className="rounded-xl bg-gray-50 border p-4">
            <p className="text-xs text-gray-500 mb-1">Batas Atas (80% CI)</p>
            <p className="text-xl font-bold text-gray-700">{formatIDR(revenue_forecast.upper_bound)}</p>
            <p className="text-xs text-gray-400 mt-2">Skenario optimistis</p>
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          {revenue_forecast.insights.map((insight, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-gray-700">
              <BarChart2 className="h-4 w-4 text-purple-400 mt-0.5 shrink-0" />
              <span>{insight}</span>
            </div>
          ))}
        </div>
      </ChartCard>

      {/* Churn Prediction Table */}
      <ChartCard
        title="Churn Prediction — Reseller Berisiko"
        description={`AI mendeteksi ${highRisk.length + mediumRisk.length} reseller berisiko dari ${churn_predictions.length} total`}
        badge={`${highRisk.length} HIGH`}
      >
        {churn_predictions.filter((p) => p.risk_level !== "NONE").length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-8 w-8 text-green-400" />}
            title="Semua reseller aman"
            description="Tidak ada tanda churn yang terdeteksi. Pertahankan performa ini!"
          />
        ) : (
          <DataTable<ChurnPredictionResult>
            columns={churnColumns}
            data={churn_predictions.filter((p) => p.risk_level !== "NONE")}
            keyExtractor={(r) => r.customer_id}
            emptyTitle="Tidak ada reseller berisiko"
            compact
          />
        )}
      </ChartCard>

      {/* Repeat Order Prediction */}
      <ChartCard
        title="Repeat Order Prediction — Order Mendekati Jatuh Tempo"
        description={`${overdue.length} overdue · ${dueThisWeek.length} jatuh tempo minggu ini`}
        badge={overdue.length > 0 ? `${overdue.length} terlambat` : "Aman"}
      >
        {(overdue.length === 0 && dueThisWeek.length === 0) ? (
          <EmptyState
            icon={<RefreshCw className="h-8 w-8 text-blue-400" />}
            title="Tidak ada order mendekati jatuh tempo"
            description="Semua reseller masih dalam window waktu normal"
          />
        ) : (
          <DataTable<RepeatOrderPrediction>
            columns={repeatColumns}
            data={[...overdue, ...dueThisWeek]}
            keyExtractor={(r) => r.customer_id}
            emptyTitle="Tidak ada data"
            compact
          />
        )}
      </ChartCard>

      {/* Executive Summary Sections */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {executive_summary.sections.map((section, i) => {
          const borderColor = {
            positive: "border-green-200",
            neutral: "border-gray-200",
            warning: "border-amber-200",
            critical: "border-red-200",
          }[section.status];
          const dotColor = {
            positive: "bg-green-500",
            neutral: "bg-gray-400",
            warning: "bg-amber-500",
            critical: "bg-red-500",
          }[section.status];

          return (
            <div key={i} className={`rounded-xl border-2 ${borderColor} bg-white p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`h-2 w-2 rounded-full ${dotColor}`} />
                <h3 className="font-semibold text-gray-900 text-sm">{section.title}</h3>
              </div>
              <p className="text-sm text-gray-700 mb-3 leading-relaxed">{section.content}</p>
              <div className="flex flex-wrap gap-3">
                {section.metrics.map((m, j) => (
                  <div key={j} className="rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <p className="text-xs text-gray-400">{m.label}</p>
                    <p className="text-sm font-semibold text-gray-900">{m.value}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-gray-400">
        AI dihasilkan pada {new Date(insights.generated_at).toLocaleString("id-ID")} · Model: {insights.model_version} · Data real-time dari database
      </p>
    </div>
  );
}
