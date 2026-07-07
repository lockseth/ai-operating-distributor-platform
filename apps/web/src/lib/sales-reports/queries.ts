import { createClient } from "@/lib/supabase/server";

// =============================================================================
// Sales Report — hybrid dengan sales_orders
// Laporan diinput manual; bila ada data sales_orders untuk sales+tanggal yang
// sama, sistem menampilkan ringkasan order sebagai pembanding.
// =============================================================================

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
