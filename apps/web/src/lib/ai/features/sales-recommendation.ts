// =============================================================================
// AI Feature: Sales Recommendation
// Menghasilkan daftar tugas harian untuk setiap sales rep
// berdasarkan data customer mereka dan pola historis.
// =============================================================================

export type TaskPriority = "URGENT" | "HIGH" | "MEDIUM" | "LOW";
export type TaskCategory = "follow_up_dormant" | "repeat_order_due" | "new_customer_activation" | "high_value_retention" | "payment_reminder";

export interface SalesTask {
  priority: TaskPriority;
  category: TaskCategory;
  customer_id: string;
  customer_name: string;
  customer_area: string;
  description: string;
  action_required: string;
  context: string;
  estimated_revenue_opportunity: number;
}

export interface SalesRecommendationResult {
  sales_id: string;
  sales_name: string;
  date: string;                       // ISO date
  total_tasks: number;
  urgent_count: number;
  summary: string;
  tasks: SalesTask[];
}

export interface CustomerForRecommendation {
  id: string;
  name: string;
  area: string;
  last_order_at: string | null;
  total_revenue: number;
  total_orders: number;
  avg_order_interval_days: number;
  days_since_last_order: number;
  predicted_next_order_in_days: number;
  has_pending_payment: boolean;
}

export function generateSalesRecommendations(
  salesId: string,
  salesName: string,
  customers: CustomerForRecommendation[],
  now: Date = new Date()
): SalesRecommendationResult {
  const tasks: SalesTask[] = [];

  for (const c of customers) {
    const generatedTasks = generateTasksForCustomer(c);
    tasks.push(...generatedTasks);
  }

  // Sort: URGENT > HIGH > MEDIUM > LOW, lalu by revenue opportunity
  const priorityOrder: Record<TaskPriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  tasks.sort((a, b) => {
    const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pd !== 0) return pd;
    return b.estimated_revenue_opportunity - a.estimated_revenue_opportunity;
  });

  const urgentCount = tasks.filter((t) => t.priority === "URGENT").length;
  const highCount = tasks.filter((t) => t.priority === "HIGH").length;

  const summary = buildSummary(salesName, tasks.length, urgentCount, highCount);

  return {
    sales_id: salesId,
    sales_name: salesName,
    date: now.toISOString().split("T")[0]!,
    total_tasks: tasks.length,
    urgent_count: urgentCount,
    summary,
    tasks: tasks.slice(0, 20),  // Maksimal 20 tugas per hari
  };
}

function generateTasksForCustomer(c: CustomerForRecommendation): SalesTask[] {
  const tasks: SalesTask[] = [];
  const isHighValue = c.total_revenue >= 5_000_000;
  const isNewCustomer = c.total_orders === 0;

  // Task 1: Dormant / Churn risk
  if (isNewCustomer) {
    tasks.push({
      priority: "HIGH",
      category: "new_customer_activation",
      customer_id: c.id,
      customer_name: c.name,
      customer_area: c.area,
      description: "Reseller baru belum pernah order",
      action_required: "Hubungi dan lakukan presentasi produk. Tawarkan order perdana dengan insentif.",
      context: `${c.name} terdaftar tapi belum pernah melakukan order.`,
      estimated_revenue_opportunity: 1_500_000,
    });
  } else if (c.days_since_last_order > 60) {
    tasks.push({
      priority: isHighValue ? "URGENT" : "HIGH",
      category: "follow_up_dormant",
      customer_id: c.id,
      customer_name: c.name,
      customer_area: c.area,
      description: `Tidak order ${c.days_since_last_order} hari — risiko churn tinggi`,
      action_required: isHighValue
        ? "Kunjungi langsung hari ini. Bawa proposal program loyalitas."
        : "Hubungi via WhatsApp/telepon. Tanyakan kendala dan tawarkan incentif.",
      context: `Revenue historis: Rp${Math.round(c.total_revenue / 1_000_000)}jt dari ${c.total_orders} order.`,
      estimated_revenue_opportunity: Math.round(c.total_revenue / c.total_orders),
    });
  } else if (c.days_since_last_order > 45) {
    tasks.push({
      priority: isHighValue ? "HIGH" : "MEDIUM",
      category: "follow_up_dormant",
      customer_id: c.id,
      customer_name: c.name,
      customer_area: c.area,
      description: `Tidak order ${c.days_since_last_order} hari — perlu follow up`,
      action_required: "Kirim pesan follow-up personal. Tanyakan kebutuhan produk bulan ini.",
      context: `Rata-rata order interval: ${c.avg_order_interval_days} hari.`,
      estimated_revenue_opportunity: c.avg_order_interval_days > 0
        ? Math.round(c.total_revenue / c.total_orders)
        : 0,
    });
  }

  // Task 2: Repeat order due
  if (
    !isNewCustomer &&
    c.avg_order_interval_days > 0 &&
    c.predicted_next_order_in_days >= -3 &&
    c.predicted_next_order_in_days <= 5
  ) {
    tasks.push({
      priority: c.predicted_next_order_in_days < 0 ? "HIGH" : "MEDIUM",
      category: "repeat_order_due",
      customer_id: c.id,
      customer_name: c.name,
      customer_area: c.area,
      description: c.predicted_next_order_in_days < 0
        ? `Estimasi repeat order sudah terlewat ${Math.abs(c.predicted_next_order_in_days)} hari`
        : `Estimasi repeat order ${c.predicted_next_order_in_days} hari lagi`,
      action_required: "Konfirmasi kebutuhan produk dan pastikan stok tersedia.",
      context: `Berdasarkan pola order ${c.avg_order_interval_days} hari sekali dari ${c.total_orders} order.`,
      estimated_revenue_opportunity: Math.round(c.total_revenue / c.total_orders),
    });
  }

  // Task 3: High value retention (aktif tapi high value)
  if (isHighValue && c.days_since_last_order <= 30 && c.days_since_last_order >= 15) {
    tasks.push({
      priority: "LOW",
      category: "high_value_retention",
      customer_id: c.id,
      customer_name: c.name,
      customer_area: c.area,
      description: "Reseller bernilai tinggi — pertahankan hubungan",
      action_required: "Check-in singkat via WhatsApp. Informasikan produk baru atau promo.",
      context: `Total revenue: Rp${Math.round(c.total_revenue / 1_000_000)}jt. Salah satu pelanggan terbaik.`,
      estimated_revenue_opportunity: Math.round(c.total_revenue / c.total_orders),
    });
  }

  return tasks;
}

function buildSummary(name: string, total: number, urgent: number, high: number): string {
  if (total === 0) {
    return `${name}, tidak ada tugas prioritas hari ini. Semua reseller dalam kondisi baik.`;
  }
  const parts: string[] = [];
  if (urgent > 0) parts.push(`${urgent} tugas URGENT`);
  if (high > 0) parts.push(`${high} prioritas tinggi`);
  const remaining = total - urgent - high;
  if (remaining > 0) parts.push(`${remaining} tugas lainnya`);
  return `${name}, hari ini kamu memiliki ${parts.join(", ")} (total ${total} tugas). Selesaikan yang URGENT lebih dulu.`;
}
