import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { getOrdersSnapshot } from "@/lib/sales-reports/queries";
import { calcGap, calcAchievementPct } from "@/lib/sales-reports/summary";
import { Sparkles, ArrowLeft, ShoppingCart } from "lucide-react";

export const metadata = { title: "Detail Laporan Sales — AODP" };

interface ReportDetail {
  id: string;
  report_date: string;
  area: string | null;
  target_oa: number;
  achieved_oa: number;
  target_revenue: number;
  achieved_revenue: number;
  remaining_working_days: number;
  discount_amount: number;
  total_value: number;
  grand_total: number;
  notes: string | null;
  ai_summary: string | null;
  salesperson_id: string;
  salesperson: { full_name: string } | null;
  items: {
    id: string;
    product_name_snapshot: string;
    quantity: number;
    unit: string;
    value: number;
  }[];
}

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

export default async function SalesReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  const hasAccess =
    hasPermission(user.permissions, "reports.view") ||
    hasRole(user.roles, ["super_admin", "owner", "manager"]);
  if (!hasAccess) redirect("/dashboard");

  const supabase = await createClient();
  const { data } = await supabase
    .from("sales_reports")
    .select(
      "id, report_date, area, target_oa, achieved_oa, target_revenue, achieved_revenue, remaining_working_days, discount_amount, total_value, grand_total, notes, ai_summary, salesperson_id, salesperson:users!salesperson_id(full_name), items:sales_report_items(id, product_name_snapshot, quantity, unit, value)"
    )
    .eq("id", id)
    .eq("company_id", user.company_id)
    .maybeSingle();

  const report = data as unknown as ReportDetail | null;
  if (!report) notFound();

  // Sales murni hanya boleh melihat laporannya sendiri
  const canViewAll = hasRole(user.roles, ["owner", "manager", "admin", "finance", "super_admin"]);
  if (!canViewAll && report.salesperson_id !== user.id) redirect("/dashboard/reports");

  const gap        = calcGap(report.target_revenue, report.achieved_revenue);
  const pctRevenue = calcAchievementPct(report.target_revenue, report.achieved_revenue);
  const pctOa      = calcAchievementPct(report.target_oa, report.achieved_oa);

  // Hybrid: pembanding dari sales_orders bila ada
  const ordersSnapshot = await getOrdersSnapshot(
    user.company_id,
    report.salesperson_id,
    report.report_date
  );

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <PageHeader
        title={`Laporan ${report.salesperson?.full_name ?? "—"}`}
        subtitle={`${formatDate(report.report_date)}${report.area ? ` • ${report.area}` : ""}`}
      >
        <Link href="/dashboard/reports"
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          <ArrowLeft className="h-4 w-4" /> Kembali
        </Link>
      </PageHeader>

      {/* KPI */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">OA (Outlet Aktif)</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{report.achieved_oa}/{report.target_oa}</p>
          <p className="text-xs text-gray-400">{pctOa}% tercapai</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Omzet</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{formatIDR(report.achieved_revenue)}</p>
          <p className="text-xs text-gray-400">target {formatIDR(report.target_revenue)} ({pctRevenue}%)</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Gap Omzet</p>
          <p className={`mt-1 text-lg font-semibold ${gap > 0 ? "text-amber-600" : "text-green-600"}`}>
            {gap > 0 ? formatIDR(gap) : "Tercapai"}
          </p>
          <p className="text-xs text-gray-400">sisa {report.remaining_working_days} hari kerja</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Grand Total Penjualan</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{formatIDR(report.grand_total)}</p>
          <p className="text-xs text-gray-400">diskon {formatIDR(report.discount_amount)}</p>
        </div>
      </div>

      {/* AI summary */}
      {report.ai_summary && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-500" />
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Ringkasan</p>
          </div>
          <p className="mt-2 text-sm text-blue-900">{report.ai_summary}</p>
        </div>
      )}

      {/* Pembanding hybrid dari sales_orders */}
      {ordersSnapshot && (
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Pembanding dari Sales Order</h2>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            Data sales order tercatat di sistem untuk sales &amp; tanggal yang sama.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <p className="text-xs text-gray-500">Jumlah Order</p>
              <p className="text-sm font-semibold text-gray-900">{ordersSnapshot.order_count}</p>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <p className="text-xs text-gray-500">Outlet Order</p>
              <p className="text-sm font-semibold text-gray-900">
                {ordersSnapshot.customer_count}
                <span className="ml-1 text-xs font-normal text-gray-400">vs {report.achieved_oa} dilaporkan</span>
              </p>
            </div>
            <div className="rounded-lg bg-gray-50 px-4 py-3">
              <p className="text-xs text-gray-500">Nilai Order</p>
              <p className="text-sm font-semibold text-gray-900">
                {formatIDR(ordersSnapshot.revenue)}
                <span className="ml-1 text-xs font-normal text-gray-400">vs {formatIDR(report.achieved_revenue)} dilaporkan</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Item produk */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Produk Terjual</h2>
        </div>
        {report.items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">Tidak ada item produk dilaporkan.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Produk</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Qty</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Satuan</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Nilai</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {report.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{item.product_name_snapshot}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{item.quantity}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{item.unit}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatIDR(item.value)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-100 bg-gray-50">
                <td colSpan={3} className="px-4 py-3 text-right text-xs font-medium text-gray-500">Total Nilai</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatIDR(report.total_value)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Catatan */}
      {report.notes && (
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">Catatan</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-gray-600">{report.notes}</p>
        </div>
      )}
    </div>
  );
}
