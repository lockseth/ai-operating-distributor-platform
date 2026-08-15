// =============================================================================
// Business Guard AI Feature: Discount Anomaly / Sales Risk Indicator
// Menghitung risiko kebocoran diskon per sales berdasarkan riwayat pengajuan
// harga khusus (special_price_approval_requests).
// Model: rule-based analytics (tanpa LLM), sama pola dengan churn-prediction.ts.
// =============================================================================

export type DiscountRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface SalesDiscountRequest {
  status: "PENDING" | "APPROVED" | "REJECTED";
  requested_at: string;
  max_discount_percentage: number; // diskon terdalam di antara baris pada pengajuan ini
}

export interface SalesDiscountActivity {
  sales_id: string;
  sales_name: string;
  requests: SalesDiscountRequest[];
}

export interface PeerBaseline {
  avg_requests_per_sales: number;
  avg_discount_percentage: number;
}

export interface DiscountAnomalyResult {
  sales_id: string;
  sales_name: string;
  risk_level: DiscountRiskLevel;
  confidence: number;              // 0.0 - 1.0
  total_requests: number;
  rejected_count: number;
  rejection_rate: number;          // 0.0 - 1.0, dari request yang sudah diputuskan
  avg_discount_percentage: number;
  max_discount_percentage: number;
  recent_vs_prior_ratio: number;   // request 30 hari terakhir vs 30 hari sebelumnya
  recommendation: string;
  signals: string[];
}

const MIN_REQUESTS_FOR_SIGNAL = 2;

export function detectDiscountAnomaly(
  activity: SalesDiscountActivity,
  peer: PeerBaseline,
  now: Date = new Date()
): DiscountAnomalyResult {
  const { sales_id, sales_name, requests } = activity;

  const totalRequests = requests.length;
  const decided = requests.filter((r) => r.status !== "PENDING");
  const rejected = requests.filter((r) => r.status === "REJECTED");
  const rejectionRate = decided.length > 0 ? rejected.length / decided.length : 0;

  const avgDiscount =
    totalRequests > 0
      ? requests.reduce((s, r) => s + r.max_discount_percentage, 0) / totalRequests
      : 0;
  const maxDiscount =
    totalRequests > 0 ? Math.max(...requests.map((r) => r.max_discount_percentage)) : 0;

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000);
  const recentCount = requests.filter((r) => new Date(r.requested_at) >= thirtyDaysAgo).length;
  const priorCount = requests.filter(
    (r) => new Date(r.requested_at) >= sixtyDaysAgo && new Date(r.requested_at) < thirtyDaysAgo
  ).length;
  const recentVsPriorRatio = priorCount > 0 ? recentCount / priorCount : recentCount > 0 ? 2 : 0;

  const signals: string[] = [];
  let riskScore = 0;

  if (totalRequests >= MIN_REQUESTS_FOR_SIGNAL) {
    // Signal 1: Volume dibanding rata-rata sales lain
    const volumeRatio = peer.avg_requests_per_sales > 0 ? totalRequests / peer.avg_requests_per_sales : 1;
    if (volumeRatio >= 2.5) {
      riskScore += 25;
      signals.push(`Pengajuan harga khusus ${totalRequests}x, ${volumeRatio.toFixed(1)}x rata-rata sales lain`);
    } else if (volumeRatio >= 1.8) {
      riskScore += 15;
      signals.push(`Pengajuan harga khusus lebih sering dari rata-rata sales lain (${volumeRatio.toFixed(1)}x)`);
    } else if (volumeRatio >= 1.3) {
      riskScore += 8;
    }

    // Signal 2: Tingkat penolakan Owner
    if (rejectionRate >= 0.5) {
      riskScore += 30;
      signals.push(`${Math.round(rejectionRate * 100)}% pengajuan ditolak Owner`);
    } else if (rejectionRate >= 0.3) {
      riskScore += 18;
      signals.push(`${Math.round(rejectionRate * 100)}% pengajuan ditolak Owner`);
    } else if (rejectionRate >= 0.15) {
      riskScore += 8;
    }

    // Signal 3: Kedalaman diskon dibanding rata-rata sales lain
    const depthRatio = peer.avg_discount_percentage > 0 ? avgDiscount / peer.avg_discount_percentage : 1;
    if (depthRatio >= 1.5) {
      riskScore += 25;
      signals.push(`Rata-rata diskon diajukan ${avgDiscount.toFixed(1)}%, ${depthRatio.toFixed(1)}x rata-rata sales lain`);
    } else if (depthRatio >= 1.25) {
      riskScore += 15;
      signals.push(`Rata-rata diskon diajukan lebih dalam dari rata-rata sales lain`);
    } else if (depthRatio >= 1.1) {
      riskScore += 8;
    }

    // Signal 4: Eskalasi -- makin sering minta belakangan ini
    if (recentCount >= 3 && recentVsPriorRatio >= 2) {
      riskScore += 20;
      signals.push(`Pengajuan meningkat tajam 30 hari terakhir (${recentCount} vs ${priorCount} periode sebelumnya)`);
    } else if (recentCount >= 2 && recentVsPriorRatio >= 1.5) {
      riskScore += 10;
      signals.push(`Pengajuan meningkat 30 hari terakhir`);
    }
  }

  riskScore = Math.min(100, riskScore);

  let risk_level: DiscountRiskLevel;
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
    confidence = totalRequests >= MIN_REQUESTS_FOR_SIGNAL ? 0.8 : 0.5;
    if (totalRequests === 0) signals.push("Tidak ada pengajuan harga khusus");
    else if (totalRequests < MIN_REQUESTS_FOR_SIGNAL) signals.push("Riwayat pengajuan masih terlalu sedikit untuk dinilai");
    else signals.push("Pola pengajuan harga khusus wajar, tidak ada tanda anomali");
  }

  confidence = Math.min(0.97, confidence);

  return {
    sales_id,
    sales_name,
    risk_level,
    confidence,
    total_requests: totalRequests,
    rejected_count: rejected.length,
    rejection_rate: Math.round(rejectionRate * 100) / 100,
    avg_discount_percentage: Math.round(avgDiscount * 10) / 10,
    max_discount_percentage: Math.round(maxDiscount * 10) / 10,
    recent_vs_prior_ratio: Math.round(recentVsPriorRatio * 10) / 10,
    recommendation: buildRecommendation(risk_level, sales_name, rejectionRate, maxDiscount),
    signals,
  };
}

function buildRecommendation(
  risk: DiscountRiskLevel,
  salesName: string,
  rejectionRate: number,
  maxDiscount: number
): string {
  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Tinjau langsung riwayat pengajuan harga khusus ${salesName} bersama customer terkait (diskon terdalam yang diajukan ${maxDiscount.toFixed(1)}%) — pola ini di luar kewajaran dibanding sales lain.`;
  }
  if (risk === "MEDIUM") {
    return rejectionRate >= 0.3
      ? `Ajak diskusi ${salesName} soal alasan pengajuan yang sering ditolak — pastikan bukan cara mengetes batas kebijakan diskon.`
      : `Pantau pengajuan ${salesName} bulan ini — diskon yang diajukan lebih dalam/lebih sering dari rata-rata.`;
  }
  if (risk === "LOW") {
    return `Belum perlu tindakan, cukup dipantau rutin bersama sales lain.`;
  }
  return `Tidak ada tindakan diperlukan.`;
}
