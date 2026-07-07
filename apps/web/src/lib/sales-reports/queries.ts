import { createClient } from "@/lib/supabase/server";
import { aggregatePerformance, type PerformanceRow } from "./summary";

// =============================================================================
// Sales Report — hybrid dengan sales_orders
// Laporan diinput manual; bila ada data sales_orders untuk sales+tanggal yang
// sama, sistem menampilkan ringkasan order sebagai pembanding.
// =============================================================================

/**
 * Ranking performa per salesperson dari laporan harian bulan berjalan.
 * Dipakai halaman Laporan Sales dan Executive Intelligence.
 */
export async function getMonthlySalesPerformance(companyId: string): Promise<PerformanceRow[]> {
  const supabase = await createClient();
  const monthStart = new Date();
  monthStart.setDate(1);

  const { data } = await supabase
    .from("sales_reports")
    .select(
      "salesperson_id, target_oa, achieved_oa, target_revenue, achieved_revenue, remaining_working_days, salesperson:users!salesperson_id(full_name)"
    )
    .eq("company_id", companyId)
    .gte("report_date", monthStart.toISOString().slice(0, 10));

  const rows = (data ?? []) as unknown as {
    salesperson_id: string;
    target_oa: number;
    achieved_oa: number;
    target_revenue: number;
    achieved_revenue: number;
    remaining_working_days: number;
    salesperson: { full_name: string } | null;
  }[];

  return aggregatePerformance(
    rows.map((r) => ({
      salesperson_id: r.salesperson_id,
      salesperson_name: r.salesperson?.full_name ?? "—",
      target_oa: r.target_oa,
      achieved_oa: r.achieved_oa,
      target_revenue: r.target_revenue,
      achieved_revenue: r.achieved_revenue,
      remaining_working_days: r.remaining_working_days,
    }))
  );
}

export interface OrdersSnapshot {
  order_count: number;
  customer_count: number;
  revenue: number;
}

/**
 * Agregasi sales_orders milik satu salesperson pada satu tanggal.
 * Mengembalikan null bila tidak ada order (pembanding tidak ditampilkan).
 */
export async function getOrdersSnapshot(
  companyId: string,
  salespersonId: string,
  reportDate: string
): Promise<OrdersSnapshot | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sales_orders")
    .select("id, customer_id, final_amount")
    .eq("company_id", companyId)
    .eq("sales_id", salespersonId)
    .neq("status", "cancelled")
    .gte("created_at", `${reportDate}T00:00:00`)
    .lte("created_at", `${reportDate}T23:59:59`);

  if (error || !data || data.length === 0) return null;

  return {
    order_count: data.length,
    customer_count: new Set(data.map((o) => o.customer_id)).size,
    revenue: data.reduce((s, o) => s + (o.final_amount ?? 0), 0),
  };
}
