import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { calcGap } from "@/lib/sales-reports/summary";
import { getOwnerSalesKpiPerformance } from "@/lib/dashboard/owner-sales-kpi-performance";
import { Plus, ClipboardList } from "lucide-react";

export const metadata = { title: "Laporan Sales — AODP" };

const LIST_LIMIT = 50;

interface ReportRow {
  id: string;
  report_date: string;
  area: string | null;
  achieved_oa: number;
  achieved_revenue: number;
  salesperson_id: string;
  salesperson: { full_name: string } | null;
}

function formatIDR(n: number) {
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000)     return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function SalesReportsPage() {
  const user = await getAuthUser();

  const hasAccess =
    hasPermission(user.permissions, "reports.view") ||
    hasRole(user.roles, ["super_admin", "owner", "manager"]);
  if (!hasAccess) redirect("/dashboard");

  const supabase   = await createClient();
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartISO = monthStart.toISOString().slice(0, 10);

  const selectCols =
    "id, report_date, area, achieved_oa, achieved_revenue, salesperson_id, salesperson:users!salesperson_id(full_name)";

  const [monthResult, listResult, kpiPerf] = await Promise.all([
    supabase
      .from("sales_reports")
      .select(selectCols)
      .eq("company_id", user.company_id)
      .gte("report_date", monthStartISO),
    supabase
      .from("sales_reports")
      .select(selectCols)
      .eq("company_id", user.company_id)
      .order("report_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT),
    getOwnerSalesKpiPerformance(user.company_id),
  ]);

  const monthReports = (monthResult.data ?? []) as unknown as ReportRow[];
  const reports      = (listResult.data ?? []) as unknown as ReportRow[];

  // Gate P4.03 follow-up: ranking "Performa Sales" TIDAK LAGI dijumlah dari
  // sales_reports (cuma selengkap laporan yang sempat difile hari itu) --
  // ditarik langsung dari governed KPI periode aktif (sumber SAMA persis
  // dengan Dashboard Owner/KPI Setup), supaya Target/Gap/Pencapaian selalu
  // ada dan tidak pernah berbeda dari yang Owner lihat di tempat lain.
  const performance = [...kpiPerf.rows]
    .sort((a, b) => b.revenue.actual - a.revenue.actual)
    .map((row) => ({
      salespersonId: row.salespersonId,
      salespersonName: row.salespersonName,
      orderCount: row.orderCount.actual,
      revenueActual: row.revenue.actual,
      revenueTarget: row.revenue.target,
      revenueGap: row.revenue.target !== null ? calcGap(row.revenue.target, row.revenue.actual) : null,
      revenuePct: row.revenue.achievementPercentage,
    }));

  const hasRealTarget = kpiPerf.periodActive;
  const totalTarget    = performance.reduce((s, p) => s + (p.revenueTarget ?? 0), 0);
  const totalAchieved  = performance.reduce((s, p) => s + p.revenueActual, 0);
  const totalOaAchieved = performance.reduce((s, p) => s + p.orderCount, 0);
  const totalGap = calcGap(totalTarget, totalAchieved);
  const totalPct = totalTarget > 0 ? Math.round((totalAchieved / totalTarget) * 100) : 0;

  const canCreate = hasPermission(user.permissions, "reports.create");
  const monthLabel = new Date().toLocaleDateString("id-ID", { month: "long", year: "numeric" });

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Laporan Sales"
        subtitle="Ringkasan KPI harian otomatis dari sistem + catatan kualitatif sales"
      >
        {canCreate && (
          <Link href="/dashboard/reports/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" />
            Buat Laporan
          </Link>
        )}
      </PageHeader>

      {/* Ringkasan bulan berjalan -- OA/Omzet sekarang auto dari governed KPI.
          Target/Gap/% cuma berarti kalau ada laporan lama (pre-redesain)
          yang masih bawa target manual; kalau tidak, jangan dikarang. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Omzet Tercapai ({monthLabel})</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{formatIDR(totalAchieved)}</p>
          <p className="text-xs text-gray-400">
            {hasRealTarget ? `dari target ${formatIDR(totalTarget)}` : "auto dari governed KPI"}
          </p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">OA Tercapai</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{totalOaAchieved}</p>
          <p className="text-xs text-gray-400">{monthReports.length} laporan bulan ini</p>
        </div>
        {hasRealTarget ? (
          <>
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <p className="text-xs text-gray-500">Pencapaian Omzet</p>
              <p className={`mt-1 text-lg font-semibold ${totalPct >= 100 ? "text-green-600" : "text-gray-900"}`}>{totalPct}%</p>
            </div>
            <div className="rounded-xl border bg-white p-4 shadow-sm">
              <p className="text-xs text-gray-500">Gap Omzet</p>
              <p className={`mt-1 text-lg font-semibold ${totalGap > 0 ? "text-amber-600" : "text-green-600"}`}>
                {totalGap > 0 ? formatIDR(totalGap) : "Tercapai"}
              </p>
            </div>
          </>
        ) : (
          <div className="rounded-xl border bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500">Target Periode</p>
            <p className="mt-1 text-sm text-gray-600">
              Lihat <Link href="/dashboard/kpi" className="text-blue-600 hover:text-blue-800">KPI Salesman</Link> untuk target vs pencapaian periode aktif.
            </p>
          </div>
        )}
      </div>

      {/* Ranking sales bulan berjalan */}
      {performance.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Performa Sales — {monthLabel}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-blue-100 bg-blue-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700">#</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700">Sales</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Order</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Omzet</th>
                  {hasRealTarget && (
                    <>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Target</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Gap</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Pencapaian</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {performance.map((p, i) => {
                  const rowHasTarget = p.revenueTarget !== null;
                  return (
                    <tr key={p.salespersonId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-xs text-gray-400">{i + 1}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">{p.salespersonName}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{p.orderCount}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatIDR(p.revenueActual)}</td>
                      {hasRealTarget && (
                        <>
                          <td className="px-4 py-3 text-right text-gray-600">{rowHasTarget ? formatIDR(p.revenueTarget!) : "—"}</td>
                          <td className={`px-4 py-3 text-right ${rowHasTarget && (p.revenueGap ?? 0) > 0 ? "text-amber-600" : rowHasTarget ? "text-green-600" : "text-gray-400"}`}>
                            {rowHasTarget ? ((p.revenueGap ?? 0) > 0 ? formatIDR(p.revenueGap!) : "Tercapai") : "—"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {rowHasTarget && p.revenuePct !== null ? (
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                p.revenuePct >= 100 ? "bg-green-50 text-green-700"
                                : p.revenuePct >= 70 ? "bg-blue-50 text-blue-700"
                                : "bg-amber-50 text-amber-700"
                              }`}>
                                {p.revenuePct}%
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daftar laporan */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Laporan Terbaru</h2>
        </div>
        {reports.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-10 w-10 text-gray-300" />}
            title="Belum ada laporan sales"
            description={canCreate ? "Klik 'Buat Laporan' untuk input laporan harian pertama." : "Laporan harian sales akan tampil di sini."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-blue-100 bg-blue-50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700">Tanggal</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700">Sales</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-blue-700">Area</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">OA</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-blue-700">Omzet</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {reports.map((r) => (
                  <tr key={r.id} className="group hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{formatDate(r.report_date)}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.salesperson?.full_name ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{r.area ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{r.achieved_oa}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatIDR(r.achieved_revenue)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/dashboard/reports/${r.id}`}
                        className="text-xs font-medium text-blue-600 hover:text-blue-800 opacity-0 group-hover:opacity-100 transition-opacity">
                        Detail →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
