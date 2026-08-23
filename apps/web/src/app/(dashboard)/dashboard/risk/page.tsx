import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { ShieldAlert, UserX, Gauge, AlertTriangle, Banknote, Wallet, Clock } from "lucide-react";
import {
  generateDiscountAnomalyReport,
  generateCollectionRiskReport,
  generateBehaviorChangeReport,
  generateTransactionRiskReport,
  generateUnremittedCollectionRiskReport,
  generateSuspiciousCallTimingReport,
} from "@/lib/business-guard/engine";
import type { DiscountRiskLevel } from "@/lib/business-guard/features/discount-anomaly";
import type { CollectionRiskLevel } from "@/lib/business-guard/features/collection-risk";
import type { BehaviorChangeRiskLevel } from "@/lib/business-guard/features/behavior-change";
import type { TransactionRiskLevel } from "@/lib/business-guard/features/transaction-risk";
import type { UnremittedCollectionRiskLevel } from "@/lib/business-guard/features/unremitted-collection";
import type { CallTimingRiskLevel } from "@/lib/business-guard/features/call-timing-anomaly";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Risk Alert — AODP" };

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

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };

interface UnifiedRiskAlert {
  category: "Sales Risk" | "Collection Risk" | "Behavior Change" | "Transaction Risk" | "Klaim Belum Diformalkan" | "Kunjungan Mencurigakan";
  riskLevel: DiscountRiskLevel;
  entityName: string;
  recommendation: string;
}

export default async function RiskPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager");

  if (!hasAccess) redirect("/dashboard");

  const [discountAnomalyReport, collectionRiskReport, behaviorChangeReport, transactionRiskReport, unremittedReport, callTimingReport] = await Promise.all([
    generateDiscountAnomalyReport(user.company_id),
    generateCollectionRiskReport(user.company_id),
    generateBehaviorChangeReport(user.company_id),
    generateTransactionRiskReport(user.company_id),
    generateUnremittedCollectionRiskReport(user.company_id),
    generateSuspiciousCallTimingReport(user.company_id),
  ]);
  const flagged = discountAnomalyReport.filter((r) => r.risk_level !== "NONE");
  const collectionFlagged = collectionRiskReport.filter((r) => r.risk_level !== "NONE");
  const behaviorFlagged = behaviorChangeReport.filter((r) => r.risk_level !== "NONE");
  const transactionFlagged = transactionRiskReport.filter((r) => r.risk_level !== "NONE");
  const unremittedFlagged = unremittedReport.filter((r) => r.risk_level !== "NONE");
  const callTimingFlagged = callTimingReport.filter((r) => r.risk_level !== "NONE");

  // Risk Alert List -- gabungan Sales Risk + Collection Risk + Behavior Change
  // + Transaction Risk, murni penggabungan + pengurutan dari report yang
  // sudah dihitung di atas, TIDAK ada logic scoring baru sama sekali. Hanya
  // entitas yang benar-benar butuh perhatian (risk_level != NONE) yang masuk
  // daftar -- ini "alert", bukan rekap penuh.
  const unifiedAlerts: UnifiedRiskAlert[] = [
    ...flagged.map((r) => ({
      category: "Sales Risk" as const,
      riskLevel: r.risk_level,
      entityName: r.sales_name,
      recommendation: r.recommendation,
    })),
    ...collectionFlagged.map((r) => ({
      category: "Collection Risk" as const,
      riskLevel: r.risk_level,
      entityName: r.customer_name,
      recommendation: r.recommendation,
    })),
    ...behaviorFlagged.map((r) => ({
      category: "Behavior Change" as const,
      riskLevel: r.risk_level,
      entityName: r.customer_name,
      recommendation: r.recommendation,
    })),
    ...transactionFlagged.map((r) => ({
      category: "Transaction Risk" as const,
      riskLevel: r.risk_level,
      entityName: `${r.order_number} — ${r.customer_name}`,
      recommendation: r.recommendation,
    })),
    ...unremittedFlagged.map((r) => ({
      category: "Klaim Belum Diformalkan" as const,
      riskLevel: r.risk_level,
      entityName: `${r.collector_name} — ${r.customer_name}`,
      recommendation: r.recommendation,
    })),
    ...callTimingFlagged.map((r) => ({
      category: "Kunjungan Mencurigakan" as const,
      riskLevel: r.risk_level,
      entityName: `${r.salesperson_name} — ${r.call_date}`,
      recommendation: r.recommendation,
    })),
  ].sort((a, b) => SEVERITY_ORDER[a.riskLevel]! - SEVERITY_ORDER[b.riskLevel]!);

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Business Guard AI"
        subtitle="Early warning system — jaga bisnis dari fraud, diskon bocor, dan transaksi berisiko."
      />

      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-medium text-emerald-800">
          Business Guard AI — 6 fitur aktif (Sales Risk, Collection Risk, Behavior Change, Transaction Risk Score, Klaim Belum Diformalkan, Kunjungan Mencurigakan)
        </p>
        <p className="mt-0.5 text-xs text-emerald-700">
          Alert risiko hanya dapat dilihat owner dan manager — tidak dapat dihapus oleh sales.
        </p>
      </div>

      {/* Risk Alert List -- gabungan Sales Risk + Collection Risk */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <ShieldAlert className="h-4 w-4 text-red-500" />
          <h2 className="text-sm font-semibold text-gray-900">Risk Alert List</h2>
          <span className="ml-auto text-xs text-gray-400">{unifiedAlerts.length} perlu perhatian</span>
        </div>

        {unifiedAlerts.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Tidak ada alert -- semua sales dan customer dalam kondisi wajar.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {unifiedAlerts.map((a, i) => (
              <div key={`${a.category}-${a.entityName}-${i}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[a.riskLevel]}`}>
                  {RISK_LABEL[a.riskLevel]}
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                  {a.category}
                </span>
                <span className="text-sm font-medium text-gray-900">{a.entityName}</span>
                <span className="flex-1 min-w-[200px] text-xs text-gray-500">{a.recommendation}</span>
              </div>
            ))}
          </div>
        )}
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
        ) : flagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua sales dalam kondisi wajar -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {flagged.map((r) => (
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

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
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
        ) : collectionFlagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua piutang dalam kondisi wajar -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {collectionFlagged.map((r) => (
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

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Behavior Change -- pola order menurun drastis / PIC berganti, fitur aktif ketiga */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <UserX className="h-4 w-4 text-purple-500" />
          <h2 className="text-sm font-semibold text-gray-900">Behavior Change — Pola Customer Berubah</h2>
          <span className="ml-auto text-xs text-gray-400">
            {behaviorChangeReport.length} customer · {behaviorFlagged.length} perlu perhatian
          </span>
        </div>

        {behaviorChangeReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Belum ada customer aktif untuk dianalisis.</p>
        ) : behaviorFlagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua customer dalam pola wajar -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {behaviorFlagged.map((r) => (
              <div key={r.customer_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.customer_name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    {r.days_since_last_order !== null && <span>{r.days_since_last_order} hari sejak order terakhir</span>}
                    {r.avg_order_interval_days !== null && <span>rata-rata interval {r.avg_order_interval_days} hari</span>}
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Transaction Risk Score -- skor per order individual, fitur aktif keempat (terakhir) */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Gauge className="h-4 w-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-gray-900">Transaction Risk Score — Order 30 Hari Terakhir</h2>
          <span className="ml-auto text-xs text-gray-400">
            {transactionRiskReport.length} order · {transactionFlagged.length} perlu perhatian
          </span>
        </div>

        {transactionRiskReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Tidak ada order confirmed dalam 30 hari terakhir untuk dianalisis.</p>
        ) : transactionFlagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua order dalam pola wajar -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {transactionFlagged.map((r) => (
              <div key={r.order_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.order_number} — {r.customer_name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{formatRupiah(r.order_total_amount)}</span>
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unremitted Collection Risk -- klaim "sudah terima pembayaran" yang belum diformalkan jadi klaim pembayaran resmi, fitur aktif kelima (Gate P4.18) */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Wallet className="h-4 w-4 text-red-500" />
          <h2 className="text-sm font-semibold text-gray-900">Klaim Belum Diformalkan — Uang Cash Berisiko Hilang</h2>
          <span className="ml-auto text-xs text-gray-400">
            {unremittedReport.length} pelaporan · {unremittedFlagged.length} perlu perhatian
          </span>
        </div>

        {unremittedReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Tidak ada pelaporan "sudah terima pembayaran" dalam 90 hari terakhir untuk dianalisis.</p>
        ) : unremittedFlagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua pelaporan pembayaran sudah diformalkan jadi klaim resmi -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {unremittedFlagged.map((r) => (
              <div key={r.activity_id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.collector_name} — {r.customer_name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    {r.reported_amount !== null && <span>{formatRupiah(r.reported_amount)}</span>}
                    <span>{r.days_elapsed} hari sejak dilaporkan</span>
                    <span>{formatJakartaDateTime(r.occurred_at)}</span>
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Suspicious Call Timing -- jarak waktu antar-kunjungan yang tidak masuk akal secara fisik, fitur aktif keenam (Gate P4.19) */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Clock className="h-4 w-4 text-purple-500" />
          <h2 className="text-sm font-semibold text-gray-900">Kunjungan Mencurigakan — Jarak Waktu Antar-Toko</h2>
          <span className="ml-auto text-xs text-gray-400">
            {callTimingReport.length} hari kunjungan · {callTimingFlagged.length} perlu perhatian
          </span>
        </div>

        {callTimingReport.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Tidak ada hari dengan &ge;2 kunjungan dalam 30 hari terakhir untuk dianalisis.</p>
        ) : callTimingFlagged.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">Semua jarak waktu kunjungan dalam pola wajar -- tidak ada yang perlu perhatian.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {callTimingFlagged.map((r) => (
              <div key={`${r.salesperson_id}-${r.call_date}`} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-gray-900">{r.salesperson_name} — {r.call_date}</p>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RISK_BADGE[r.risk_level]}`}>
                      {RISK_LABEL[r.risk_level]}
                    </span>
                  </div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{r.total_calls} kunjungan</span>
                    {r.min_gap_seconds !== null && <span>jarak terketat {r.min_gap_seconds} detik</span>}
                    <span>{r.tight_gap_count} pasang &lt; 2 menit</span>
                  </div>
                </div>

                {r.signals.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.signals.map((s, i) => (
                      <li key={i} className="text-xs text-gray-600">• {s}</li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 text-xs italic text-gray-500">{r.recommendation}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
