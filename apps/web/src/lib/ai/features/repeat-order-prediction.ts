// =============================================================================
// AI Feature: Repeat Order Prediction
// Memprediksi tanggal order berikutnya per customer berdasarkan interval historis.
// =============================================================================

export interface RepeatOrderPrediction {
  customer_id: string;
  customer_name: string;
  last_order_at: string | null;
  avg_interval_days: number;
  stddev_interval_days: number;
  predicted_next_order_at: string | null;
  days_until_next_order: number;    // Negatif = sudah lewat estimasi
  confidence: number;               // 0.0 – 1.0, tinggi jika interval konsisten
  is_overdue: boolean;
  total_orders: number;
  recommendation: string;
}

export interface CustomerOrderHistory {
  customer_id: string;
  customer_name: string;
  last_order_at: string | null;
  order_dates: string[];
}

export function predictRepeatOrder(
  customer: CustomerOrderHistory,
  now: Date = new Date()
): RepeatOrderPrediction {
  const { customer_id, customer_name, last_order_at, order_dates } = customer;
  const totalOrders = order_dates.length;

  if (totalOrders < 2 || !last_order_at) {
    return {
      customer_id,
      customer_name,
      last_order_at,
      avg_interval_days: 0,
      stddev_interval_days: 0,
      predicted_next_order_at: null,
      days_until_next_order: 0,
      confidence: 0.1,
      is_overdue: false,
      total_orders: totalOrders,
      recommendation: totalOrders === 0
        ? "Belum pernah order. Fokus pada aktivasi awal."
        : "Hanya 1 order. Belum cukup data untuk prediksi. Lakukan follow-up untuk mendorong order kedua.",
    };
  }

  const sorted = [...order_dates].sort();
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(
      (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86_400_000
    );
  }

  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const stddev = computeStddev(intervals, avgInterval);

  // Confidence: tinggi jika stddev rendah relatif terhadap rata-rata
  const cv = avgInterval > 0 ? stddev / avgInterval : 1;
  const confidence = Math.max(0.1, Math.min(0.95, 1 - cv * 0.8));

  const lastOrderDate = new Date(last_order_at);
  const predictedNextMs = lastOrderDate.getTime() + avgInterval * 86_400_000;
  const predictedNextDate = new Date(predictedNextMs);
  const daysUntil = Math.round((predictedNextMs - now.getTime()) / 86_400_000);
  const isOverdue = daysUntil < 0;

  return {
    customer_id,
    customer_name,
    last_order_at,
    avg_interval_days: Math.round(avgInterval),
    stddev_interval_days: Math.round(stddev),
    predicted_next_order_at: predictedNextDate.toISOString(),
    days_until_next_order: daysUntil,
    confidence,
    is_overdue: isOverdue,
    total_orders: totalOrders,
    recommendation: buildRecommendation(daysUntil, avgInterval, confidence, customer_name),
  };
}

function computeStddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function buildRecommendation(
  daysUntil: number,
  avgInterval: number,
  confidence: number,
  name: string
): string {
  if (daysUntil < -7) {
    return `${name} sudah ${Math.abs(daysUntil)} hari melewati estimasi order. Hubungi segera — kemungkinan beralih ke supplier lain.`;
  }
  if (daysUntil < 0) {
    return `${name} sudah melewati estimasi order. Kirim pengingat hari ini.`;
  }
  if (daysUntil <= 3) {
    return `Hubungi ${name} dalam 1-2 hari — estimasi order ${daysUntil} hari lagi. Pastikan stok produk tersedia.`;
  }
  if (daysUntil <= 7) {
    return `Siapkan proposal order untuk ${name}. Estimasi order ${daysUntil} hari lagi.`;
  }
  const intervalStr = confidence >= 0.7
    ? `setiap ~${Math.round(avgInterval)} hari (konsisten)`
    : `setiap ~${Math.round(avgInterval)} hari (tidak konsisten)`;
  return `${name} biasanya order ${intervalStr}. Order berikutnya diprediksi ${daysUntil} hari lagi.`;
}

// Batch prediction untuk seluruh customers
export function predictRepeatOrdersBatch(
  customers: CustomerOrderHistory[],
  now: Date = new Date()
): RepeatOrderPrediction[] {
  return customers
    .map((c) => predictRepeatOrder(c, now))
    .sort((a, b) => a.days_until_next_order - b.days_until_next_order);
}
