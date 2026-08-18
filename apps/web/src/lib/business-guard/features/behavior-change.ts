// =============================================================================
// Business Guard AI Feature: Behavior Change (customer)
// Deteksi perubahan pola perilaku customer yang mencurigakan: (1) pola order
// tiba-tiba berhenti/menurun drastis dibanding kebiasaan customer itu sendiri
// (self-baseline -- beda dari Sales Risk yang peer-relative), dan (2) PIC toko
// berganti (dari customer_relationship_events, Gate PIC master 2026-07-28 --
// tidak perlu tabel baru). Model: rule-based analytics (tanpa LLM), pola sama
// dengan collection-risk.ts (ambang absolut per sinyal, bukan ML).
// =============================================================================

export type BehaviorChangeRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface CustomerBehaviorActivity {
  customer_id: string;
  customer_name: string;
  /** confirmed_at seluruh sales_orders customer ini dalam window lookback (urutan bebas, di-sort di dalam). */
  confirmed_order_dates: string[];
  /** Jumlah event PIC_NAME_CHANGED/PIC_PHONE_CHANGED dalam window lookback (dihitung pemanggil). */
  pic_field_change_count: number;
  /** true kalau ada PIC_DEACTIVATED DAN PIC_ADDED (PIC diganti total) dalam window lookback. */
  pic_fully_replaced: boolean;
  /** true kalau ada DUPLICATE_PIC_DETECTED/DUPLICATE_STORE_DETECTED dalam window lookback. */
  has_duplicate_flag: boolean;
}

export interface BehaviorChangeResult {
  customer_id: string;
  customer_name: string;
  risk_level: BehaviorChangeRiskLevel;
  confidence: number; // 0.0 - 1.0
  days_since_last_order: number | null;
  avg_order_interval_days: number | null; // null kalau histori order kurang dari MIN_ORDERS_FOR_BASELINE
  pic_field_change_count: number;
  pic_fully_replaced: boolean;
  has_duplicate_flag: boolean;
  recommendation: string;
  signals: string[];
}

const MIN_ORDERS_FOR_BASELINE = 3;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 86_400_000));
}

export function detectBehaviorChange(
  activity: CustomerBehaviorActivity,
  now: Date = new Date(),
): BehaviorChangeResult {
  const {
    customer_id,
    customer_name,
    confirmed_order_dates,
    pic_field_change_count,
    pic_fully_replaced,
    has_duplicate_flag,
  } = activity;

  const signals: string[] = [];
  let riskScore = 0;

  const sortedDates = confirmed_order_dates
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const daysSinceLastOrder = sortedDates.length > 0 ? daysBetween(now, sortedDates[sortedDates.length - 1]!) : null;
  let avgIntervalDays: number | null = null;

  // Signal 1: order pattern drop -- self-baseline, butuh histori minimal supaya
  // rata-rata interval bermakna (bukan dipaksakan dari 1-2 data point).
  if (sortedDates.length >= MIN_ORDERS_FOR_BASELINE) {
    const intervals: number[] = [];
    for (let i = 1; i < sortedDates.length; i++) {
      intervals.push(daysBetween(sortedDates[i]!, sortedDates[i - 1]!));
    }
    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    avgIntervalDays = avgInterval;

    if (daysSinceLastOrder !== null && avgInterval > 0) {
      const ratio = daysSinceLastOrder / avgInterval;
      if (ratio > 3) {
        riskScore += 60;
        signals.push(
          `Sudah ${daysSinceLastOrder} hari sejak order terakhir -- jauh melebihi rata-rata interval biasanya (${Math.round(avgInterval)} hari)`,
        );
      } else if (ratio > 2) {
        riskScore += 40;
        signals.push(
          `Sudah ${daysSinceLastOrder} hari sejak order terakhir -- lebih dari 2x rata-rata interval biasanya (${Math.round(avgInterval)} hari)`,
        );
      } else if (ratio > 1.5) {
        riskScore += 20;
        signals.push(
          `Sudah ${daysSinceLastOrder} hari sejak order terakhir -- mulai melebihi rata-rata interval biasanya (${Math.round(avgInterval)} hari)`,
        );
      }
    }
  } else if (sortedDates.length > 0) {
    signals.push("Histori order masih terlalu sedikit untuk hitung baseline pola order (minimal 3 order)");
  }

  // Signal 2: PIC berganti.
  if (pic_fully_replaced) {
    riskScore += 30;
    signals.push("PIC toko diganti total (PIC lama nonaktif, PIC baru ditambahkan) dalam periode ini");
  } else if (pic_field_change_count >= 2) {
    riskScore += 20;
    signals.push(`Info PIC (nama/telepon) berubah ${pic_field_change_count}x -- pola tidak biasa`);
  } else if (pic_field_change_count === 1) {
    riskScore += 10;
    signals.push("Info PIC (nama/telepon) berubah baru-baru ini");
  }

  // Signal 3: percobaan duplikasi PIC/toko.
  if (has_duplicate_flag) {
    riskScore += 10;
    signals.push("Terdeteksi percobaan duplikasi PIC/toko baru-baru ini");
  }

  riskScore = Math.min(100, riskScore);

  let risk_level: BehaviorChangeRiskLevel;
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
    if (signals.length === 0) signals.push("Belum ada perubahan perilaku mencurigakan terdeteksi");
  }

  confidence = Math.min(0.97, confidence);

  return {
    customer_id,
    customer_name,
    risk_level,
    confidence,
    days_since_last_order: daysSinceLastOrder,
    avg_order_interval_days: avgIntervalDays !== null ? Math.round(avgIntervalDays) : null,
    pic_field_change_count,
    pic_fully_replaced,
    has_duplicate_flag,
    recommendation: buildRecommendation(risk_level, customer_name, daysSinceLastOrder),
    signals,
  };
}

function buildRecommendation(
  risk: BehaviorChangeRiskLevel,
  customerName: string,
  daysSinceLastOrder: number | null,
): string {
  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Hubungi ${customerName} langsung untuk cek kondisi toko -- pola order/PIC berubah drastis dari kebiasaan (${daysSinceLastOrder ?? "?"} hari sejak order terakhir).`;
  }
  if (risk === "MEDIUM") {
    return `Jadwalkan kunjungan cek ke ${customerName} minggu ini -- ada perubahan pola yang perlu dikonfirmasi.`;
  }
  if (risk === "LOW") {
    return `Pantau ${customerName} pada kunjungan rutin berikutnya.`;
  }
  return "Tidak ada tindakan diperlukan.";
}
