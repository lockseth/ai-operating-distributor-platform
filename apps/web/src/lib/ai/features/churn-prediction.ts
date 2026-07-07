// =============================================================================
// AI Feature: Churn Prediction
// Menghitung risiko churn per customer berdasarkan pola historis order.
// Model: rule-based analytics (tanpa LLM). Enhancement opsional via LLM.
// =============================================================================

export type ChurnRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface ChurnPredictionResult {
  customer_id: string;
  customer_name: string;
  risk_level: ChurnRiskLevel;
  confidence: number;           // 0.0 – 1.0
  days_since_last_order: number;
  avg_order_interval_days: number;
  overdue_days: number;         // hari melewati estimasi order berikutnya
  total_orders: number;
  total_revenue: number;
  recommendation: string;
  signals: string[];            // Faktor yang berkontribusi ke prediksi ini
}

export interface CustomerOrderData {
  customer_id: string;
  customer_name: string;
  last_order_at: string | null;
  order_dates: string[];        // Semua tanggal order, ascending
  total_revenue: number;
}

export function predictChurn(
  customer: CustomerOrderData,
  now: Date = new Date()
): ChurnPredictionResult {
  const { customer_id, customer_name, last_order_at, order_dates, total_revenue } = customer;

  const totalOrders = order_dates.length;
  const daysSinceLast = last_order_at
    ? Math.floor((now.getTime() - new Date(last_order_at).getTime()) / 86_400_000)
    : 9999;

  const avgInterval = computeAvgInterval(order_dates);
  const overdueDays = avgInterval > 0 ? Math.max(0, daysSinceLast - avgInterval) : 0;

  const signals: string[] = [];
  let riskScore = 0;

  // Signal 1: Days since last order
  if (daysSinceLast > 60) { riskScore += 40; signals.push(`Tidak order ${daysSinceLast} hari`); }
  else if (daysSinceLast > 45) { riskScore += 30; signals.push(`Tidak order ${daysSinceLast} hari`); }
  else if (daysSinceLast > 30) { riskScore += 15; signals.push(`Tidak order ${daysSinceLast} hari`); }

  // Signal 2: Overdue vs expected interval
  if (avgInterval > 0 && overdueDays > 14) { riskScore += 20; signals.push(`Melewati estimasi order ${overdueDays} hari`); }
  else if (avgInterval > 0 && overdueDays > 7) { riskScore += 10; signals.push(`Melewati estimasi order ${overdueDays} hari`); }

  // Signal 3: Decreasing order frequency (last 3 vs prior 3 intervals)
  const frequencyDecline = detectFrequencyDecline(order_dates);
  if (frequencyDecline > 0.3) { riskScore += 20; signals.push(`Frekuensi order menurun ${Math.round(frequencyDecline * 100)}%`); }

  // Signal 4: Very low order count (never really engaged)
  if (totalOrders <= 1) { riskScore += 10; signals.push("Riwayat order sangat sedikit"); }

  // Normalize to 0-100
  riskScore = Math.min(100, riskScore);

  let risk_level: ChurnRiskLevel;
  let confidence: number;

  if (riskScore >= 60) {
    risk_level = "HIGH";
    confidence = 0.85 + (riskScore - 60) / 400;
  } else if (riskScore >= 35) {
    risk_level = "MEDIUM";
    confidence = 0.65 + (riskScore - 35) / 250;
  } else if (riskScore >= 15) {
    risk_level = "LOW";
    confidence = 0.55;
  } else {
    risk_level = "NONE";
    confidence = 0.80;
    signals.push("Order reguler, tidak ada tanda churn");
  }

  confidence = Math.min(0.97, confidence);

  return {
    customer_id,
    customer_name,
    risk_level,
    confidence,
    days_since_last_order: daysSinceLast > 900 ? -1 : daysSinceLast,
    avg_order_interval_days: Math.round(avgInterval),
    overdue_days: Math.round(overdueDays),
    total_orders: totalOrders,
    total_revenue,
    recommendation: buildRecommendation(risk_level, daysSinceLast, avgInterval, total_revenue),
    signals,
  };
}

function computeAvgInterval(dates: string[]): number {
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort();
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    total += (new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime()) / 86_400_000;
  }
  return total / (sorted.length - 1);
}

function detectFrequencyDecline(dates: string[]): number {
  if (dates.length < 4) return 0;
  const sorted = [...dates].sort();
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  const avgFirst = computeAvgInterval(firstHalf);
  const avgSecond = computeAvgInterval(secondHalf);

  if (avgFirst === 0) return 0;
  return Math.max(0, (avgSecond - avgFirst) / avgFirst);
}

function buildRecommendation(
  risk: ChurnRiskLevel,
  daysSince: number,
  avgInterval: number,
  revenue: number
): string {
  const isHighValue = revenue >= 5_000_000;
  if (risk === "HIGH") {
    return isHighValue
      ? `PRIORITAS TINGGI: Kunjungi langsung dalam 2 hari. Tawarkan program loyalitas atau diskon reaktivasi.`
      : `Hubungi via telepon atau WhatsApp. Tanyakan kendala dan tawarkan incentif order.`;
  }
  if (risk === "MEDIUM") {
    return avgInterval > 0
      ? `Kirim pesan follow-up personal. Estimasi order berikutnya ${Math.round(avgInterval - daysSince)} hari lagi.`
      : `Kirim pesan follow-up dan tanyakan kebutuhan produk saat ini.`;
  }
  if (risk === "LOW") {
    return `Pantau terus. Hubungi jika tidak ada order dalam 7 hari ke depan.`;
  }
  return `Tidak ada tindakan diperlukan. Pertahankan hubungan baik.`;
}
