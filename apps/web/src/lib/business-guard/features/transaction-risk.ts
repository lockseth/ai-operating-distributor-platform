// =============================================================================
// Business Guard AI Feature: Transaction Risk Score
// Beda dari 3 slice lain (Sales Risk, Collection Risk, Behavior Change) yang
// agregat per-entity -- ini skor PER TRANSAKSI (per sales_order individual),
// early warning saat 1 order tunggal terlihat janggal dibanding kebiasaan.
// Model: rule-based analytics (tanpa LLM), pola sama dengan feature lain.
// =============================================================================

export type TransactionRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface OrderItemQuantityOutlier {
  product_name: string;
  quantity: number;
  avg_quantity: number;
}

export interface TransactionActivity {
  order_id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  confirmed_at: string;
  order_total_amount: number;
  /** Rata-rata nilai order historis customer ini (dari window baseline, TIDAK termasuk order ini). Null kalau customer belum punya histori. */
  customer_avg_order_value: number | null;
  /** true kalau customer ini belum punya order confirmed lain sebelum window baseline. */
  is_first_order: boolean;
  /** Rata-rata nilai order company (baseline umum), dipakai saat is_first_order true. */
  company_avg_order_value: number;
  /** Baris item dengan quantity jauh melebihi rata-rata kuantitas order untuk produk itu (dihitung pemanggil, sudah difilter min. histori). */
  item_quantity_outliers: OrderItemQuantityOutlier[];
}

export interface TransactionRiskResult {
  order_id: string;
  order_number: string;
  customer_id: string;
  customer_name: string;
  risk_level: TransactionRiskLevel;
  confidence: number; // 0.0 - 1.0
  order_total_amount: number;
  confirmed_at: string;
  recommendation: string;
  signals: string[];
}

export function detectTransactionRisk(
  activity: TransactionActivity,
  now: Date = new Date(),
): TransactionRiskResult {
  const {
    order_id,
    order_number,
    customer_id,
    customer_name,
    confirmed_at,
    order_total_amount,
    customer_avg_order_value,
    is_first_order,
    company_avg_order_value,
    item_quantity_outliers,
  } = activity;

  const signals: string[] = [];
  let riskScore = 0;

  // Signal 1: nilai order vs baseline customer sendiri (self-baseline).
  if (customer_avg_order_value !== null && customer_avg_order_value > 0) {
    const ratio = order_total_amount / customer_avg_order_value;
    if (ratio > 5) {
      riskScore += 60;
      signals.push(
        `Nilai order ${ratio.toFixed(1)}x dari rata-rata order customer ini sebelumnya`,
      );
    } else if (ratio > 3) {
      riskScore += 40;
      signals.push(
        `Nilai order ${ratio.toFixed(1)}x dari rata-rata order customer ini sebelumnya`,
      );
    } else if (ratio > 2) {
      riskScore += 20;
      signals.push(
        `Nilai order ${ratio.toFixed(1)}x dari rata-rata order customer ini sebelumnya`,
      );
    }
  }

  // Signal 2: order pertama customer baru langsung besar (vs rata-rata company).
  if (is_first_order && company_avg_order_value > 0) {
    const ratio = order_total_amount / company_avg_order_value;
    if (ratio > 5) {
      riskScore += 60;
      signals.push(`Order pertama customer baru ini ${ratio.toFixed(1)}x rata-rata order company`);
    } else if (ratio > 3) {
      riskScore += 40;
      signals.push(`Order pertama customer baru ini ${ratio.toFixed(1)}x rata-rata order company`);
    } else if (ratio > 2) {
      riskScore += 20;
      signals.push(`Order pertama customer baru ini ${ratio.toFixed(1)}x rata-rata order company`);
    }
  }

  // Signal 3: kuantitas item outlier.
  if (item_quantity_outliers.length >= 2) {
    riskScore += 20;
    signals.push(
      `${item_quantity_outliers.length} item dengan jumlah pesan jauh di luar kebiasaan (${item_quantity_outliers
        .map((o) => o.product_name)
        .slice(0, 3)
        .join(", ")})`,
    );
  } else if (item_quantity_outliers.length === 1) {
    riskScore += 10;
    signals.push(
      `Item "${item_quantity_outliers[0]!.product_name}" dipesan ${item_quantity_outliers[0]!.quantity} -- jauh di atas rata-rata (${Math.round(item_quantity_outliers[0]!.avg_quantity)})`,
    );
  }

  riskScore = Math.min(100, riskScore);

  let risk_level: TransactionRiskLevel;
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
    confidence = 0.7;
    if (signals.length === 0) signals.push("Transaksi dalam pola wajar, tidak ada sinyal risiko");
  }

  confidence = Math.min(0.97, confidence);

  return {
    order_id,
    order_number,
    customer_id,
    customer_name,
    risk_level,
    confidence,
    order_total_amount,
    confirmed_at,
    recommendation: buildRecommendation(risk_level, order_number, customer_name),
    signals,
  };
}

function buildRecommendation(
  risk: TransactionRiskLevel,
  orderNumber: string,
  customerName: string,
): string {
  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Cek ulang order ${orderNumber} (${customerName}) sebelum diproses lebih lanjut -- nilai/kuantitas jauh di luar kebiasaan.`;
  }
  if (risk === "MEDIUM") {
    return `Konfirmasi ke ${customerName} bahwa order ${orderNumber} sudah sesuai sebelum dikirim.`;
  }
  if (risk === "LOW") {
    return `Order ${orderNumber} sedikit di luar kebiasaan -- pantau saat proses pengiriman.`;
  }
  return "Tidak ada tindakan diperlukan.";
}
