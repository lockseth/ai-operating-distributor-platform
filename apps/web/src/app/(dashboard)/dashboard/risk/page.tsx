import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { ShieldAlert, UserX, Gauge, AlertTriangle, Banknote } from "lucide-react";
import { generateDiscountAnomalyReport, generateCollectionRiskReport } from "@/lib/business-guard/engine";
import type { DiscountRiskLevel } from "@/lib/business-guard/features/discount-anomaly";
import type { CollectionRiskLevel } from "@/lib/business-guard/features/collection-risk";
import { formatRupiah } from "@/lib/document-engine/monetary";

export const metadata = { title: "Risk Alert — AODP" };

const FEATURE_CARDS = [
  {
    icon: <ShieldAlert className="h-6 w-6 text-red-500" />,
    title: "Risk Alert List",
    description: "Daftar alert dengan severity, kategori, entitas terkait, dan rekomendasi tindakan untuk owner.",
    badge: "Segera Hadir",
    color: "red",
  },
  {
    icon: <UserX className="h-6 w-6 text-purple-500" />,
    title: "Behavior Change",
    description: "Alert saat perilaku customer berubah mencurigakan — PIC order berganti, pola order menurun drastis.",
    badge: "Segera Hadir",
    color: "purple",
  },
  {
    icon: <Gauge className="h-6 w-6 text-blue-500" />,
    title: "Transaction Risk Score",
    description: "Skor risiko per transaksi sebagai early warning system.",
    badge: "Segera Hadir",
    color: "blue",
  },
];

const BADGE_COLOR: Record<string, string> = {
  red:    "bg-red-50 text-red-700",
  orange: "bg-orange-50 text-orange-700",
  purple: "bg-purple-50 text-purple-700",
  blue:   "bg-blue-50 text-blue-700",
};

const RISK_BADGE: Record<DiscountRiskLevel, string> = {
  HIGH:   "bg-red-100 text-red-700",
  MEDIUM: "bg-amber-100 text-amber-700",
  LOW:    "bg-yellow-50 text-yellow-700",
  NONE:   "bg-gray-100 text-gray-500",
};

const RISK_LABEL: Record<DiscountRiskLevel, string> = {
  HIGH:   "Risiko Tinggi",
  MEDIUM: "Risiko Sedang",
  LOW:    "Risiko Rendah",
  NONE:   "Aman",
};

function formatPercent(n: number) {
  return `${n.toFixed(1)}%`;
}

export default async function RiskPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager");

  if (!hasAccess) redirect("/dashboard");

  const [discountAnomalyReport, collectionRiskReport] = await Promise.all([
    generateDiscountAnomalyReport(user.company_id),
    generateCollectionRiskReport(user.company_id),
  ]);
  const flagged = discountAnomalyReport.filter((r) => r.risk_level !== "NONE");
  const collectionFlagged = collectionRiskReport.filter((r) => r.risk_level !== "NONE");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Business Guard AI"
        subtitle="Early warning system — jaga bisnis dari fraud, diskon bocor, dan transaksi berisiko."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">
          Modul Business Guard AI sedang dibangun bertahap
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Alert risiko hanya dapat dilihat owner dan manager — tidak dapat dihapus oleh sales.
        </p>
      </div>

      {/* Discount Anomaly / Sales Risk Indicator -- fitur aktif pertama */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          <h2 className="text-sm font-semibold text-gray-900">Sales Risk — Anomali Diskon</h2>
          <span className="ml-auto text-xs text-gray-400">
            {discountAnomalyReport.length} sales · {flagged.length} perlu perhatian
          </span>
        </div>

        {discountAnomalyReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Belum ada sales aktif untuk dianalisis.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {discountAnomalyReport.map((r) => (
              <div key={r.sales_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.sales_name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{r.total_requests} pengajuan</span>
                    <span>{Math.round(r.rejection_rate * 100)}% ditolak</span>
                    <span>rata-rata diskon {formatPercent(r.avg_discount_percentage)}</span>
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                {r.risk_level !== "NONE" && (
                  <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collection Risk -- piutang berisiko macet, fitur aktif kedua */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Banknote className="h-4 w-4 text-orange-500" />
          <h2 className="text-sm font-semibold text-gray-900">Collection Risk — Piutang Berisiko Macet</h2>
          <span className="ml-auto text-xs text-gray-400">
            {collectionRiskReport.length} customer · {collectionFlagged.length} perlu perhatian
          </span>
        </div>

        {collectionRiskReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Tidak ada piutang outstanding untuk dianalisis.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {collectionRiskReport.map((r) => (
              <div key={r.customer_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.customer_name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{r.outstanding_invoice_count} invoice outstanding</span>
                    <span>{formatRupiah(r.total_outstanding_amount)}</span>
                    {r.max_age_days !== null && <span>{r.max_age_days} hari lewat jatuh tempo</span>}
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                {r.risk_level !== "NONE" && (
                  <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FEATURE_CARDS.map((card) => (
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
    </div>
  );
}
