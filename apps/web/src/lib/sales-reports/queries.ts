import { createClient } from "@/lib/supabase/server";
import { aggregatePerformance, type PerformanceRow } from "./summary";

const ORDER_STATUSES_COUNTED = [
  "confirmed", "processing", "delivering", "delivered", "invoiced", "paid",
] as const;

// =============================================================================
// Sales Report — Gate P4.03: angka KPI (Call/EC/Order/Omzet/NOO) & produk
// terjual dihitung otomatis dari governed ledger + sales_orders, bukan lagi
// diinput manual. Sales hanya mengisi bagian kualitatif (area, catatan,
// sisa hari kerja) yang memang tidak bisa diotomatisasi.
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

// =============================================================================
// Gate P4.03 — Ringkasan KPI harian read-only (redesain Laporan Sales).
// Sumber tunggal: sales_kpi_achievement_events, ledger append-only yang sama
// yang dipakai dashboard Owner (aggregateGovernedKpisBySalesperson,
// lib/dashboard/owner-sales-kpi-performance.ts) -- supaya angka di laporan
// sales SELALU identik dengan yang dilihat Owner, bukan sumber kebenaran
// kedua. Di-scope 1 hari (business_date = reportDate), bukan periode KPI
// aktif penuh seperti dashboard Owner.
// =============================================================================

export interface DailyGovernedKpiSummary {
  call: number;
  effectiveCall: number;
  orderCount: number;
  revenue: number;
  noo: number;
}

const GOVERNED_KPI_CODES = ["CALL", "EFFECTIVE_CALL", "ORDER_COUNT", "REVENUE", "NOO"] as const;

export async function getDailyGovernedKpiSummary(
  companyId: string,
  salespersonId: string,
  reportDate: string
): Promise<DailyGovernedKpiSummary> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("sales_kpi_achievement_events")
    .select("kpi_code, event_type, value")
    .eq("company_id", companyId)
    .eq("salesperson_id", salespersonId)
    .eq("business_date", reportDate);

  const totals: Record<(typeof GOVERNED_KPI_CODES)[number], number> = {
    CALL: 0, EFFECTIVE_CALL: 0, ORDER_COUNT: 0, REVENUE: 0, NOO: 0,
  };

  for (const row of (data ?? []) as { kpi_code: string; event_type: string; value: number | string | null }[]) {
    if (!(GOVERNED_KPI_CODES as readonly string[]).includes(row.kpi_code)) continue;
    const code = row.kpi_code as (typeof GOVERNED_KPI_CODES)[number];
    const sign = row.event_type === "CREDITED" ? 1 : -1;
    totals[code] += sign * Number(row.value ?? 0);
  }

  return {
    call: totals.CALL,
    effectiveCall: totals.EFFECTIVE_CALL,
    orderCount: totals.ORDER_COUNT,
    revenue: totals.REVENUE,
    noo: totals.NOO,
  };
}

export interface DailySoldItem {
  product_id: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  value: number;
}

/**
 * Breakdown produk terjual hari itu -- pengganti input manual item[] di form
 * lama. Bukan bagian dari governed KPI (tidak ada breakdown per-produk di
 * situ), jadi diagregasi langsung dari sales_order_items/sales_orders --
 * status disamakan dengan definisi ORDER_COUNT governed ("confirmed" atau
 * status lanjutannya, bukan draft/cancelled).
 */
export async function getDailySoldItems(
  companyId: string,
  salespersonId: string,
  reportDate: string
): Promise<DailySoldItem[]> {
  const supabase = await createClient();

  const { data: orders } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("company_id", companyId)
    .eq("sales_id", salespersonId)
    .in("status", ORDER_STATUSES_COUNTED)
    .gte("created_at", `${reportDate}T00:00:00`)
    .lte("created_at", `${reportDate}T23:59:59`);

  const orderIds = (orders ?? []).map((o) => o.id as string);
  if (orderIds.length === 0) return [];

  const { data: items } = await supabase
    .from("sales_order_items")
    .select("product_id, quantity, total_amount, product:products(name, unit)")
    .in("order_id", orderIds);

  const byProduct = new Map<string, DailySoldItem>();
  for (const row of (items ?? []) as unknown as {
    product_id: string;
    quantity: number;
    total_amount: number;
    product: { name: string; unit: string } | { name: string; unit: string }[] | null;
  }[]) {
    const product = Array.isArray(row.product) ? row.product[0] : row.product;
    const existing = byProduct.get(row.product_id);
    if (existing) {
      existing.quantity += row.quantity;
      existing.value += row.total_amount;
    } else {
      byProduct.set(row.product_id, {
        product_id: row.product_id,
        product_name: product?.name ?? "—",
        unit: product?.unit ?? "pcs",
        quantity: row.quantity,
        value: row.total_amount,
      });
    }
  }
  return [...byProduct.values()];
}
