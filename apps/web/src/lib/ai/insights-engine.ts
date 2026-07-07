// =============================================================================
// AI Insights Engine
// Server-side: query DB, jalankan semua 5 AI features, cache ke ai_insights.
// =============================================================================

import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { predictChurn } from "./features/churn-prediction";
import { predictRepeatOrdersBatch } from "./features/repeat-order-prediction";
import { forecastRevenue } from "./features/revenue-forecast";
import { generateSalesRecommendations } from "./features/sales-recommendation";
import { generateExecutiveSummary } from "./features/executive-summary";
import type { ChurnPredictionResult } from "./features/churn-prediction";
import type { RepeatOrderPrediction } from "./features/repeat-order-prediction";
import type { RevenueForecastResult } from "./features/revenue-forecast";
import type { SalesRecommendationResult } from "./features/sales-recommendation";
import type { ExecutiveSummaryResult } from "./features/executive-summary";

export interface AiInsightsBundle {
  churn_predictions: ChurnPredictionResult[];
  repeat_order_predictions: RepeatOrderPrediction[];
  revenue_forecast: RevenueForecastResult;
  sales_recommendations: SalesRecommendationResult[];
  executive_summary: ExecutiveSummaryResult;
  generated_at: string;
  company_id: string;
  model_version: string;
}

// Upsert insight cache
async function cacheInsight(
  companyId: string,
  featureType: string,
  result: unknown,
  ttlMinutes = 60
): Promise<void> {
  try {
    const supabase = getAdminClient();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await supabase.from("ai_insights").upsert({
      company_id: companyId,
      feature_type: featureType,
      entity_type: "company",
      entity_id: null,
      result,
      model_version: "rule-based-v1",
      expires_at: expiresAt,
    }, {
      onConflict: "company_id,feature_type",
      ignoreDuplicates: false,
    });
  } catch {
    // Cache failure is non-fatal
  }
}

export async function generateAllInsights(
  companyId: string,
  forceRefresh = false
): Promise<AiInsightsBundle> {
  const supabase = await createClient();
  const now = new Date();
  const sixMonthsAgo = new Date("2026-01-01");
  const modelVersion = "rule-based-v1";

  // ── 1. Fetch all raw data in parallel ──
  const [ordersResult, customersResult, usersResult, companyResult] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("id, customer_id, sales_id, final_amount, status, created_at")
      .eq("company_id", companyId)
      .gte("created_at", sixMonthsAgo.toISOString())
      .in("status", ["confirmed", "delivering", "delivered", "invoiced", "paid"])
      .order("created_at", { ascending: true }),

    supabase
      .from("customers")
      .select("id, code, name, area, last_order_at, assigned_sales_id, total_orders")
      .eq("company_id", companyId),

    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("is_active", true),

    supabase
      .from("companies")
      .select("name")
      .eq("id", companyId)
      .maybeSingle(),
  ]);

  type OrderRow = {
    id: string; customer_id: string; sales_id: string;
    final_amount: number; status: string; created_at: string;
  };
  type CustomerRow = {
    id: string; code: string; name: string; area: string;
    last_order_at: string | null; assigned_sales_id: string | null; total_orders: number;
  };
  type UserRow = { id: string; full_name: string };

  const orders = (ordersResult.data ?? []) as unknown as OrderRow[];
  const customers = (customersResult.data ?? []) as unknown as CustomerRow[];
  const users = (usersResult.data ?? []) as unknown as UserRow[];
  const companyName = (companyResult.data as { name: string } | null)?.name ?? "Perusahaan";

  const userMap: Record<string, string> = {};
  users.forEach((u) => { userMap[u.id] = u.full_name; });

  // ── 2. Build per-customer aggregations ──
  const customerOrderMap: Record<string, { dates: string[]; revenue: number }> = {};
  orders.forEach((o) => {
    if (!customerOrderMap[o.customer_id]) {
      customerOrderMap[o.customer_id] = { dates: [], revenue: 0 };
    }
    customerOrderMap[o.customer_id]!.dates.push(o.created_at);
    customerOrderMap[o.customer_id]!.revenue += o.final_amount ?? 0;
  });

  // ── 3. Churn Predictions ──
  const churnInputs = customers.map((c) => ({
    customer_id: c.id,
    customer_name: c.name,
    last_order_at: c.last_order_at,
    order_dates: customerOrderMap[c.id]?.dates ?? [],
    total_revenue: customerOrderMap[c.id]?.revenue ?? 0,
  }));

  const churnPredictions = churnInputs.map((c) => predictChurn(c, now));
  const highRiskCount = churnPredictions.filter((p) => p.risk_level === "HIGH").length;

  // ── 4. Repeat Order Predictions ──
  const repeatInputs = customers.map((c) => ({
    customer_id: c.id,
    customer_name: c.name,
    last_order_at: c.last_order_at,
    order_dates: customerOrderMap[c.id]?.dates ?? [],
  }));
  const repeatPredictions = predictRepeatOrdersBatch(repeatInputs, now);

  // ── 5. Revenue Forecast ──
  const monthlyMap: Record<string, { revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    const d = new Date(o.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { revenue: 0, orders: 0 };
    monthlyMap[key]!.revenue += o.final_amount ?? 0;
    monthlyMap[key]!.orders += 1;
  });
  const monthlyData = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, revenue: v.revenue, orders: v.orders }));

  const revenueForecast = forecastRevenue(companyId, monthlyData);

  // ── 6. Sales Recommendations ──
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const salesMap: Record<string, CustomerRow[]> = {};
  customers.forEach((c) => {
    const sid = c.assigned_sales_id ?? "unassigned";
    if (!salesMap[sid]) salesMap[sid] = [];
    salesMap[sid]!.push(c);
  });

  const salesRecommendations: SalesRecommendationResult[] = [];
  for (const [salesId, salesCustomers] of Object.entries(salesMap)) {
    if (salesId === "unassigned") continue;
    const salesName = userMap[salesId] ?? "Sales";

    const customerInputs = salesCustomers.map((c) => {
      const cOrders = customerOrderMap[c.id];
      const avgInterval = computeAvgInterval(cOrders?.dates ?? []);
      const daysSince = c.last_order_at
        ? Math.floor((now.getTime() - new Date(c.last_order_at).getTime()) / 86_400_000)
        : 9999;
      const predictedNext = avgInterval > 0 ? daysSince - avgInterval : 0;

      return {
        id: c.id,
        name: c.name,
        area: c.area ?? "-",
        last_order_at: c.last_order_at,
        total_revenue: cOrders?.revenue ?? 0,
        total_orders: cOrders?.dates.length ?? 0,
        avg_order_interval_days: Math.round(avgInterval),
        days_since_last_order: daysSince,
        predicted_next_order_in_days: Math.round(predictedNext),
        has_pending_payment: false,
      };
    });

    salesRecommendations.push(
      generateSalesRecommendations(salesId, salesName, customerInputs, now)
    );
  }

  // ── 7. Executive Summary ──
  const totalRevenue = orders.reduce((s, o) => s + (o.final_amount ?? 0), 0);

  // Revenue this month vs last month
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const thisMonthRevenue = monthlyMap[thisMonth]?.revenue ?? 0;
  const lastMonthRevenue = monthlyMap[lastMonthKey]?.revenue ?? 0;
  const revenueVsPct = lastMonthRevenue > 0
    ? Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100)
    : 0;

  const activeResellers = customers.filter(
    (c) => c.last_order_at && new Date(c.last_order_at) >= thirtyDaysAgo
  ).length;

  const dormantResellers = customers.length - activeResellers;
  const neverOrdered = customers.filter((c) => !c.last_order_at).length;
  const highValueDormant = churnPredictions.filter(
    (p) => p.risk_level !== "NONE" && p.total_revenue >= 5_000_000
  ).length;

  // Build top sales
  const salesRevMap: Record<string, { name: string; revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    if (!o.sales_id) return;
    if (!salesRevMap[o.sales_id]) salesRevMap[o.sales_id] = { name: userMap[o.sales_id] ?? "?", revenue: 0, orders: 0 };
    salesRevMap[o.sales_id]!.revenue += o.final_amount ?? 0;
    salesRevMap[o.sales_id]!.orders += 1;
  });
  const topSales = Object.values(salesRevMap).sort((a, b) => b.revenue - a.revenue).slice(0, 3);

  // Build top areas
  const areaOrderMap: Record<string, number> = {};
  customers.forEach((c) => {
    const area = c.area ?? "-";
    areaOrderMap[area] = (areaOrderMap[area] ?? 0) + (customerOrderMap[c.id]?.dates.length ?? 0);
  });
  const topAreas = Object.entries(areaOrderMap)
    .map(([area, order_count]) => ({ area, order_count }))
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, 3);

  const monthNames = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  const periodLabel = `${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  const execSummary = generateExecutiveSummary(companyId, {
    company_name: companyName,
    period_label: periodLabel,
    total_revenue: totalRevenue,
    revenue_vs_last_month_pct: revenueVsPct,
    total_orders: orders.length,
    active_resellers: activeResellers,
    dormant_resellers: dormantResellers,
    total_resellers: customers.length,
    repeat_order_rate: churnPredictions.length > 0
      ? Math.round((churnPredictions.filter((p) => p.total_orders > 1).length / churnPredictions.length) * 100)
      : 0,
    churn_risk_count: highRiskCount,
    never_ordered_count: neverOrdered,
    forecast_next_month: revenueForecast.predicted_revenue,
    forecast_growth_pct: revenueForecast.growth_rate_pct,
    top_sales: topSales,
    top_areas: topAreas,
    high_value_dormant: highValueDormant,
  });

  // ── 8. Cache results ──
  if (!forceRefresh) {
    await Promise.allSettled([
      cacheInsight(companyId, "executive_summary", execSummary, 60),
      cacheInsight(companyId, "revenue_forecast", revenueForecast, 120),
    ]);
  }

  return {
    churn_predictions: churnPredictions,
    repeat_order_predictions: repeatPredictions,
    revenue_forecast: revenueForecast,
    sales_recommendations: salesRecommendations,
    executive_summary: execSummary,
    generated_at: now.toISOString(),
    company_id: companyId,
    model_version: modelVersion,
  };
}

function computeAvgInterval(dates: string[]): number {
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort();
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    total += (new Date(sorted[i]!).getTime() - new Date(sorted[i - 1]!).getTime()) / 86_400_000;
  }
  return total / (sorted.length - 1);
}
