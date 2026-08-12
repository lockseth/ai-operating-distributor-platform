import Link from "next/link";
import { Trophy } from "lucide-react";
import type { OwnerSalesKpiPerformanceRow } from "@/lib/dashboard/owner-sales-kpi-performance";

interface SalesPerformanceCardProps {
  rows: OwnerSalesKpiPerformanceRow[];
  periodActive: boolean;
  periodName: string | null;
}

function formatIDR(n: number) {
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000) return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

function formatCount(n: number) {
  return n.toLocaleString("id-ID");
}

function CountCell({ target, actual }: { target: number | null; actual: number }) {
  if (target === null) {
    return <span className="text-gray-400">{formatCount(actual)}/—</span>;
  }
  return (
    <span>
      {formatCount(actual)}/{formatCount(target)}
    </span>
  );
}

// =============================================================================
// Performa Sales -- drill-down per salesperson, governed (Gate Owner BI-C).
// Kelima kolom KPI (Call/EC/Order/NOO/Omzet) dan badge "Capai" bersumber dari
// sales_kpi_targets + sales_kpi_achievement_events periode KPI ACTIVE lewat
// getOwnerSalesKpiPerformance -- BUKAN lagi sales_reports self-report. Legacy
// OA sengaja TIDAK ditampilkan di sini (lock decision #2/#6; lihat tile
// "OA Bulan Ini (Self-Report — Legacy)" di KPI Grid tenant-wide untuk info OA).
// =============================================================================

export function SalesPerformanceCard({ rows, periodActive, periodName }: SalesPerformanceCardProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50">
          <Trophy className="h-4 w-4 text-amber-600" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Performa Sales {periodActive && periodName ? `— ${periodName}` : ""}
          </h2>
          <p className="text-xs text-gray-500">
            5 KPI governed periode aktif (Call, Effective Call, Order Count, Omzet, NOO)
          </p>
        </div>
        <Link
          href="/dashboard/reports"
          className="ml-auto text-xs font-medium text-blue-600 hover:text-blue-800"
        >
          Lihat semua →
        </Link>
      </div>

      {!periodActive ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">
          Belum ada periode KPI aktif — aktifkan periode di KPI Setup untuk memantau performa sales.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">
          Belum ada sales aktif untuk dipantau pada periode ini.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500">#</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-gray-500">Sales</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">Call</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">EC</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">Order</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">NOO</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">Omzet</th>
                <th className="px-3 py-2.5 text-right text-xs font-medium text-gray-500">Capai</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.slice(0, 5).map((r, i) => (
                <tr key={r.salespersonId} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 text-xs text-gray-400">{i + 1}</td>
                  <td className="px-3 py-2.5 font-medium text-gray-900">{r.salespersonName}</td>
                  <td className="px-3 py-2.5 text-right text-gray-600">
                    <CountCell target={r.call.target} actual={r.call.actual} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-600">
                    <CountCell target={r.effectiveCall.target} actual={r.effectiveCall.actual} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-600">
                    <CountCell target={r.orderCount.target} actual={r.orderCount.actual} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-gray-600">
                    <CountCell target={r.noo.target} actual={r.noo.actual} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-gray-900">
                    {formatIDR(r.revenue.actual)}
                    {r.revenue.target !== null && (
                      <span className="ml-1 font-normal text-gray-400">/ {formatIDR(r.revenue.target)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {r.revenue.achievementPercentage === null ? (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                        Data belum cukup
                      </span>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          r.revenue.achievementPercentage >= 100
                            ? "bg-green-50 text-green-700"
                            : r.revenue.achievementPercentage >= 70
                              ? "bg-blue-50 text-blue-700"
                              : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {r.revenue.achievementPercentage}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
