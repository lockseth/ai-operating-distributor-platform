import Link from "next/link";
import { Trophy } from "lucide-react";
import type { PerformanceRow } from "@/lib/sales-reports/summary";

interface SalesPerformanceCardProps {
  performance: PerformanceRow[];
  monthLabel: string;
}

function formatIDR(n: number) {
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000) return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

export function SalesPerformanceCard({ performance, monthLabel }: SalesPerformanceCardProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50">
          <Trophy className="h-4 w-4 text-amber-600" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Performa Sales — {monthLabel}</h2>
          <p className="text-xs text-gray-500">Dari laporan harian sales (target vs pencapaian)</p>
        </div>
        <Link
          href="/dashboard/reports"
          className="ml-auto text-xs font-medium text-blue-600 hover:text-blue-800"
        >
          Lihat semua →
        </Link>
      </div>

      {performance.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">
          Belum ada laporan sales bulan ini.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">#</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500">Sales</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">OA</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Omzet</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Gap</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500">Capai</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {performance.slice(0, 5).map((p, i) => (
              <tr key={p.salesperson_id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 text-xs text-gray-400">{i + 1}</td>
                <td className="px-4 py-2.5 font-medium text-gray-900">{p.salesperson_name}</td>
                <td className="px-4 py-2.5 text-right text-gray-600">
                  {p.achieved_oa}/{p.target_oa}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold text-gray-900">
                  {formatIDR(p.achieved_revenue)}
                </td>
                <td
                  className={`px-4 py-2.5 text-right ${p.gap_revenue > 0 ? "text-amber-600" : "text-green-600"}`}
                >
                  {p.gap_revenue > 0 ? formatIDR(p.gap_revenue) : "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.achievement_pct >= 100
                        ? "bg-green-50 text-green-700"
                        : p.achievement_pct >= 70
                          ? "bg-blue-50 text-blue-700"
                          : "bg-amber-50 text-amber-700"
                    }`}
                  >
                    {p.achievement_pct}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
