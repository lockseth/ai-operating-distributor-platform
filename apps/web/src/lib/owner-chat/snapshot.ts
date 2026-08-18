// =============================================================================
// Fondasi data chatbot bisnis Owner -- satu titik akses gabungan yang bisa
// dipakai fitur AI apapun nanti (chatbot, dsb.) untuk menjawab pertanyaan
// umum Owner: "produk paling laku?", "toko paling banyak order?", "KPI
// sekarang gimana?", "ada risiko apa?". Read-only murni, tidak sentuh RPC.
//
// Scope SENGAJA dibatasi ke lapisan data -- TIDAK memanggil packages/ai/LLM
// sama sekali (lihat catatan TRACKER.md: packages/ai belum pernah dipakai,
// itu effort terpisah).
// =============================================================================

import { createClient } from "@/lib/supabase/server";
import {
  generateDiscountAnomalyReport,
  generateCollectionRiskReport,
  generateBehaviorChangeReport,
  generateTransactionRiskReport,
} from "@/lib/business-guard/engine";
import { aggregateGovernedKpis, type GovernedKpiAggregate } from "@/lib/executive/contributors/flowsales";
import type { SalesKpiCode } from "@/lib/sales-kpi/types";
import {
  aggregateTopProducts,
  aggregateTopCustomers,
  summarizeRiskLevels,
  type TopProductResult,
  type TopCustomerResult,
  type RiskLevelCounts,
} from "./aggregates";

export interface DateRange {
  from: Date;
  to: Date;
}

export interface OwnerBusinessSnapshot {
  dateRange: { from: string; to: string };
  topProducts: TopProductResult[];
  topCustomers: TopCustomerResult[];
  /** null kalau tidak ada periode KPI ACTIVE/LOCKED sama sekali. */
  kpiStatus: Record<SalesKpiCode, GovernedKpiAggregate> | null;
  riskSummary: {
    salesRisk: RiskLevelCounts;
    collectionRisk: RiskLevelCounts;
    behaviorChange: RiskLevelCounts;
    transactionRisk: RiskLevelCounts;
  };
}

type OrderRow = {
  id: string;
  customer_id: string;
  final_amount: number;
  customer: { name: string } | { name: string }[] | null;
};
type ItemRow = { product_id: string | null; product_name_raw: string; quantity: number; total_amount: number };
type ActivePeriodRow = { id: string; start_date: string; end_date: string };
type KpiTargetRow = { target_value: number; kpi_definition: { code: SalesKpiCode } | { code: SalesKpiCode }[] | null };
type KpiEventRow = { kpi_code: SalesKpiCode; event_type: "CREDITED" | "REVERSED"; value: number | string | null };

function resolveCustomerName(customer: OrderRow["customer"]): string {
  if (!customer) return "-";
  return Array.isArray(customer) ? (customer[0]?.name ?? "-") : customer.name;
}

export async function getOwnerBusinessSnapshot(
  companyId: string,
  range: DateRange,
  limit = 10,
): Promise<OwnerBusinessSnapshot> {
  const supabase = await createClient();

  const [ordersResult, activePeriodResult, discountReport, collectionReport, behaviorReport, transactionReport] =
    await Promise.all([
      supabase
        .from("sales_orders")
        .select("id, customer_id, final_amount, customer:customers!customer_id(name)")
        .eq("company_id", companyId)
        .not("confirmed_at", "is", null)
        .gte("confirmed_at", range.from.toISOString())
        .lte("confirmed_at", range.to.toISOString()),
      // Periode KPI ACTIVE terbaru -- pola query sama persis dengan
      // lib/executive/contributors/flowsales.ts (LOCKED, sengaja tidak
      // direfactor untuk reuse supaya tidak menyentuh contributor yang
      // sudah locked & hosted-verified).
      supabase
        .from("sales_kpi_periods")
        .select("id, start_date, end_date")
        .eq("company_id", companyId)
        .in("status", ["ACTIVE", "LOCKED"])
        .order("end_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      generateDiscountAnomalyReport(companyId),
      generateCollectionRiskReport(companyId),
      generateBehaviorChangeReport(companyId),
      generateTransactionRiskReport(companyId),
    ]);

  const orders = (ordersResult.data ?? []) as unknown as OrderRow[];
  const orderIds = orders.map((o) => o.id);

  const itemsResult =
    orderIds.length > 0
      ? await supabase
          .from("sales_order_items")
          .select("product_id, product_name_raw, quantity, total_amount")
          .in("order_id", orderIds)
      : { data: [] as ItemRow[] };
  const items = (itemsResult.data ?? []) as ItemRow[];

  const topProducts = aggregateTopProducts(
    items.map((it) => ({
      product_id: it.product_id,
      product_name: it.product_name_raw,
      quantity: it.quantity,
      revenue: it.total_amount,
    })),
    limit,
  );

  const topCustomers = aggregateTopCustomers(
    orders.map((o) => ({
      customer_id: o.customer_id,
      customer_name: resolveCustomerName(o.customer),
      final_amount: o.final_amount,
    })),
    limit,
  );

  const activePeriod = activePeriodResult.data as ActivePeriodRow | null;
  let kpiStatus: Record<SalesKpiCode, GovernedKpiAggregate> | null = null;
  if (activePeriod) {
    const [targetsRes, eventsRes] = await Promise.all([
      supabase
        .from("sales_kpi_targets")
        .select("target_value, kpi_definition:sales_kpi_definitions(code)")
        .eq("company_id", companyId)
        .eq("period_id", activePeriod.id)
        .eq("status", "ACTIVE"),
      supabase
        .from("sales_kpi_achievement_events")
        .select("kpi_code, event_type, value")
        .eq("company_id", companyId)
        .gte("business_date", activePeriod.start_date)
        .lte("business_date", activePeriod.end_date),
    ]);
    kpiStatus = aggregateGovernedKpis(
      (targetsRes.data ?? []) as unknown as KpiTargetRow[],
      (eventsRes.data ?? []) as unknown as KpiEventRow[],
    );
  }

  return {
    dateRange: { from: range.from.toISOString(), to: range.to.toISOString() },
    topProducts,
    topCustomers,
    kpiStatus,
    riskSummary: {
      salesRisk: summarizeRiskLevels(discountReport.map((r) => r.risk_level)),
      collectionRisk: summarizeRiskLevels(collectionReport.map((r) => r.risk_level)),
      behaviorChange: summarizeRiskLevels(behaviorReport.map((r) => r.risk_level)),
      transactionRisk: summarizeRiskLevels(transactionReport.map((r) => r.risk_level)),
    },
  };
}
