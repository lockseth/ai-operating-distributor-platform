import { createClient } from "@/lib/supabase/server";

export interface MonthlyRevenue {
  month: string;
  label: string;
  revenue: number;
  orders: number;
}

export interface SalesPerformance {
  sales_id: string;
  sales_name: string;
  order_count: number;
  revenue: number;
  customer_count: number;
}

export interface AreaPerformance {
  area: string;
  order_count: number;
  revenue: number;
}

export interface RecentOrder {
  id: string;
  order_number: string;
  customer_name: string;
  sales_name: string;
  final_amount: number;
  status: string;
  created_at: string;
}

export interface FollowUpCustomer {
  id: string;
  code: string;
  name: string;
  area: string;
  sales_name: string;
  last_order_at: string | null;
  days_inactive: number;
}

export interface AiAlert {
  type: "alert" | "warning" | "opportunity" | "info";
  title: string;
  message: string;
  metric?: string;
  action?: string;
}

export interface OwnerDashboardData {
  // KPI
  totalRevenue6Months: number;
  revenueThisMonth: number;
  revenueToday: number;
  ordersThisMonth: number;
  repeatOrderRate: number;
  activeResellers: number;
  dormantResellers: number;
  totalResellers: number;
  totalOrders6Months: number;

  // Charts
  monthlyRevenue: MonthlyRevenue[];
  areaPerformance: AreaPerformance[];

  // Tables
  salesPerformance: SalesPerformance[];
  recentOrders: RecentOrder[];
  followUpCustomers: FollowUpCustomer[];

  // AI
  aiAlerts: AiAlert[];
  forecastNextMonth: number;
  forecastGrowthRate: number;
}

const MONTH_LABELS: Record<number, string> = {
  1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr",
  5: "Mei", 6: "Jun", 7: "Jul", 8: "Agu",
  9: "Sep", 10: "Okt", 11: "Nov", 12: "Des",
};

function linearForecast(values: number[]): number {
  const n = values.length;
  if (n < 2) return values[0] ?? 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - xMean) * (v - yMean);
    den += (i - xMean) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  return Math.max(0, Math.round(intercept + slope * n));
}

export async function fetchOwnerDashboardData(
  companyId: string
): Promise<OwnerDashboardData> {
  const supabase = await createClient();

  const now = new Date();
  const sixMonthsAgo = new Date("2026-01-01");
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const fortyFiveDaysAgo = new Date(now);
  fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // === PARALLEL QUERIES ===
  const [
    ordersResult,
    customersResult,
    usersResult,
  ] = await Promise.all([
    // All orders 6 months with customer + sales info
    supabase
      .from("sales_orders")
      .select(`
        id, order_number, final_amount, status, created_at,
        customer_id, sales_id,
        customers!inner(name, area, code),
        users!sales_id(full_name)
      `)
      .eq("company_id", companyId)
      .gte("created_at", sixMonthsAgo.toISOString())
      .in("status", ["confirmed", "delivering", "delivered", "invoiced", "paid"])
      .order("created_at", { ascending: true }),

    // All customers
    supabase
      .from("customers")
      .select("id, code, name, area, last_order_at, assigned_sales_id")
      .eq("company_id", companyId),

    // Sales users
    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", companyId)
      .eq("is_active", true),
  ]);

  type OrderRow = {
    id: string;
    order_number: string;
    final_amount: number;
    status: string;
    created_at: string;
    customer_id: string;
    sales_id: string;
    customers: { name: string; area: string; code: string } | null;
    users: { full_name: string } | null;
  };

  type CustomerRow = {
    id: string;
    code: string;
    name: string;
    area: string;
    last_order_at: string | null;
    assigned_sales_id: string | null;
  };

  type UserRow = { id: string; full_name: string };

  const orders = ((ordersResult.data ?? []) as unknown as OrderRow[]);
  const customers = ((customersResult.data ?? []) as unknown as CustomerRow[]);
  const users = ((usersResult.data ?? []) as unknown as UserRow[]);

  const userMap: Record<string, string> = {};
  users.forEach((u) => { userMap[u.id] = u.full_name; });

  // === KPI ===
  const totalRevenue6Months = orders.reduce((s, o) => s + (o.final_amount ?? 0), 0);

  const revenueThisMonth = orders
    .filter((o) => new Date(o.created_at) >= firstOfMonth)
    .reduce((s, o) => s + (o.final_amount ?? 0), 0);

  const revenueToday = orders
    .filter((o) => new Date(o.created_at) >= startOfToday)
    .reduce((s, o) => s + (o.final_amount ?? 0), 0);

  const ordersThisMonth = orders
    .filter((o) => new Date(o.created_at) >= firstOfMonth)
    .length;

  const totalResellers = customers.length;

  const activeResellers = customers.filter(
    (c) => c.last_order_at && new Date(c.last_order_at) >= thirtyDaysAgo
  ).length;

  const dormantResellers = totalResellers - activeResellers;

  // Repeat Order Rate
  const ordersByCustomer: Record<string, number> = {};
  orders.forEach((o) => {
    ordersByCustomer[o.customer_id] = (ordersByCustomer[o.customer_id] ?? 0) + 1;
  });
  const customersWithOrders = Object.keys(ordersByCustomer).length;
  const customersWithRepeat = Object.values(ordersByCustomer).filter((c) => c > 1).length;
  const repeatOrderRate =
    customersWithOrders > 0
      ? Math.round((customersWithRepeat / customersWithOrders) * 100)
      : 0;

  const totalOrders6Months = orders.length;

  // === MONTHLY REVENUE ===
  const monthlyMap: Record<string, { revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    const d = new Date(o.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyMap[key]) monthlyMap[key] = { revenue: 0, orders: 0 };
    monthlyMap[key].revenue += o.final_amount ?? 0;
    monthlyMap[key].orders += 1;
  });

  const monthlyRevenue: MonthlyRevenue[] = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => {
      const [, m] = key.split("-");
      return {
        month: key,
        label: MONTH_LABELS[parseInt(m)] ?? m,
        revenue: Math.round(v.revenue),
        orders: v.orders,
      };
    });

  // === FORECAST ===
  const revenueValues = monthlyRevenue.map((m) => m.revenue);
  const forecastNextMonth = linearForecast(revenueValues);
  const lastRevenue = revenueValues[revenueValues.length - 1] ?? 0;
  const forecastGrowthRate =
    lastRevenue > 0
      ? Math.round(((forecastNextMonth - lastRevenue) / lastRevenue) * 100)
      : 0;

  // === SALES PERFORMANCE ===
  const salesMap: Record<
    string,
    { revenue: number; orders: number; customers: Set<string> }
  > = {};
  orders.forEach((o) => {
    const sid = o.sales_id;
    if (!sid) return;
    if (!salesMap[sid]) salesMap[sid] = { revenue: 0, orders: 0, customers: new Set() };
    salesMap[sid].revenue += o.final_amount ?? 0;
    salesMap[sid].orders += 1;
    salesMap[sid].customers.add(o.customer_id);
  });

  const salesPerformance: SalesPerformance[] = Object.entries(salesMap)
    .map(([sid, v]) => ({
      sales_id: sid,
      sales_name: userMap[sid] ?? "Unknown",
      order_count: v.orders,
      revenue: Math.round(v.revenue),
      customer_count: v.customers.size,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // === AREA PERFORMANCE ===
  const areaMap: Record<string, { revenue: number; orders: number }> = {};
  orders.forEach((o) => {
    const area = o.customers?.area ?? "Tidak diketahui";
    if (!areaMap[area]) areaMap[area] = { revenue: 0, orders: 0 };
    areaMap[area].revenue += o.final_amount ?? 0;
    areaMap[area].orders += 1;
  });

  const areaPerformance: AreaPerformance[] = Object.entries(areaMap)
    .map(([area, v]) => ({
      area,
      order_count: v.orders,
      revenue: Math.round(v.revenue),
    }))
    .sort((a, b) => b.order_count - a.order_count)
    .slice(0, 8);

  // === RECENT ORDERS ===
  const recentOrders: RecentOrder[] = [...orders]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)
    .map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_name: o.customers?.name ?? "-",
      sales_name: userMap[o.sales_id] ?? "-",
      final_amount: o.final_amount,
      status: o.status,
      created_at: o.created_at,
    }));

  // === FOLLOW UP CUSTOMERS ===
  const followUpCustomers: FollowUpCustomer[] = customers
    .filter((c) => {
      if (!c.last_order_at) return true;
      return new Date(c.last_order_at) < fortyFiveDaysAgo;
    })
    .map((c) => {
      const daysInactive = c.last_order_at
        ? Math.floor(
            (now.getTime() - new Date(c.last_order_at).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 999;
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        area: c.area ?? "-",
        sales_name: userMap[c.assigned_sales_id ?? ""] ?? "-",
        last_order_at: c.last_order_at,
        days_inactive: daysInactive,
      };
    })
    .sort((a, b) => b.days_inactive - a.days_inactive)
    .slice(0, 10);

  // === AI ALERTS ===
  const churnCount = customers.filter((c) => {
    if (!c.last_order_at) return false;
    return new Date(c.last_order_at) < fortyFiveDaysAgo;
  }).length;

  const neverOrdered = customers.filter((c) => !c.last_order_at).length;

  const highValueThreshold = 5_000_000;
  const highValueDormant = customers.filter((c) => {
    if (!c.last_order_at) return false;
    if (new Date(c.last_order_at) >= thirtyDaysAgo) return false;
    const customerRevenue = orders
      .filter((o) => o.customer_id === c.id)
      .reduce((s, o) => s + (o.final_amount ?? 0), 0);
    return customerRevenue >= highValueThreshold;
  }).length;

  const aiAlerts: AiAlert[] = [];

  if (churnCount > 0) {
    aiAlerts.push({
      type: "alert",
      title: "Churn Risk Terdeteksi",
      message: `${churnCount} reseller tidak melakukan order lebih dari 45 hari. Segera lakukan follow up untuk mencegah churn.`,
      metric: `${churnCount} reseller berisiko tinggi`,
      action: "Lihat daftar di bawah → Perlu Follow Up",
    });
  }

  if (highValueDormant > 0) {
    aiAlerts.push({
      type: "warning",
      title: "Pelanggan Bernilai Tinggi Dormant",
      message: `${highValueDormant} reseller dengan nilai order >Rp5 juta tidak order dalam 30+ hari. Potensi revenue loss signifikan.`,
      metric: `${highValueDormant} high-value customer dormant`,
      action: "Prioritaskan kunjungan sales ke pelanggan ini",
    });
  }

  if (forecastGrowthRate > 0) {
    aiAlerts.push({
      type: "opportunity",
      title: "Tren Pertumbuhan Positif",
      message: `Berdasarkan tren 6 bulan, revenue bulan depan diproyeksikan tumbuh ${forecastGrowthRate}%. Pertahankan momentum ini.`,
      metric: `Forecast: +${forecastGrowthRate}% dari bulan ini`,
    });
  } else if (forecastGrowthRate < -5) {
    aiAlerts.push({
      type: "warning",
      title: "Proyeksi Revenue Menurun",
      message: `Tren menunjukkan potensi penurunan revenue ${Math.abs(forecastGrowthRate)}% bulan depan. Evaluasi strategi sales.`,
      metric: `Forecast: ${forecastGrowthRate}% dari bulan ini`,
    });
  }

  if (repeatOrderRate >= 70) {
    aiAlerts.push({
      type: "opportunity",
      title: "Repeat Order Rate Tinggi",
      message: `${repeatOrderRate}% reseller melakukan lebih dari 1 order. Tingkat loyalitas sangat baik — manfaatkan untuk program referral.`,
      metric: `Repeat Order Rate: ${repeatOrderRate}%`,
    });
  }

  if (neverOrdered > 0) {
    aiAlerts.push({
      type: "info",
      title: "Reseller Belum Pernah Order",
      message: `${neverOrdered} reseller terdaftar tapi belum pernah melakukan order. Perlu aktivasi oleh tim sales.`,
      metric: `${neverOrdered} reseller perlu aktivasi`,
    });
  }

  return {
    totalRevenue6Months,
    revenueThisMonth,
    revenueToday,
    ordersThisMonth,
    repeatOrderRate,
    activeResellers,
    dormantResellers,
    totalResellers,
    totalOrders6Months,
    monthlyRevenue,
    areaPerformance,
    salesPerformance,
    recentOrders,
    followUpCustomers,
    aiAlerts,
    forecastNextMonth,
    forecastGrowthRate,
  };
}
