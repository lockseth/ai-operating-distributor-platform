// =============================================================================
// AI Feature: Executive Summary
// Ringkasan eksekutif performa bisnis untuk Owner / Manager.
// Menghasilkan narasi terstruktur dari data dashboard.
// =============================================================================

export interface ExecutiveSummaryInput {
  company_name: string;
  period_label: string;               // "Juni 2026" atau "6 bulan terakhir"
  total_revenue: number;
  revenue_vs_last_month_pct: number;  // Persentase vs bulan lalu
  total_orders: number;
  active_resellers: number;
  dormant_resellers: number;
  total_resellers: number;
  repeat_order_rate: number;          // 0-100
  churn_risk_count: number;
  never_ordered_count: number;
  forecast_next_month: number;
  forecast_growth_pct: number;
  top_sales: Array<{ name: string; revenue: number; orders: number }>;
  top_areas: Array<{ area: string; order_count: number }>;
  high_value_dormant: number;
}

export interface ExecutiveSummaryResult {
  company_id: string;
  period: string;
  generated_at: string;
  headline: string;
  performance_rating: "excellent" | "good" | "average" | "needs_attention" | "critical";
  sections: ExecutiveSummarySection[];
  key_actions: KeyAction[];
  overall_insight: string;
}

export interface ExecutiveSummarySection {
  title: string;
  content: string;
  status: "positive" | "neutral" | "warning" | "critical";
  metrics: Array<{ label: string; value: string }>;
}

export interface KeyAction {
  priority: "URGENT" | "HIGH" | "MEDIUM";
  action: string;
  rationale: string;
  expected_impact: string;
}

function formatIDR(amount: number): string {
  if (amount >= 1_000_000_000) return `Rp${(amount / 1_000_000_000).toFixed(1)}M`;
  if (amount >= 1_000_000) return `Rp${(amount / 1_000_000).toFixed(1)}jt`;
  return `Rp${Math.round(amount / 1_000)}rb`;
}

function computePerformanceRating(input: ExecutiveSummaryInput): ExecutiveSummaryResult["performance_rating"] {
  let score = 0;

  if (input.revenue_vs_last_month_pct > 10) score += 2;
  else if (input.revenue_vs_last_month_pct > 0) score += 1;
  else if (input.revenue_vs_last_month_pct < -10) score -= 2;
  else if (input.revenue_vs_last_month_pct < 0) score -= 1;

  if (input.repeat_order_rate >= 70) score += 2;
  else if (input.repeat_order_rate >= 50) score += 1;
  else if (input.repeat_order_rate < 30) score -= 1;

  const dormantRatio = input.total_resellers > 0
    ? input.dormant_resellers / input.total_resellers
    : 0;
  if (dormantRatio < 0.2) score += 1;
  else if (dormantRatio > 0.4) score -= 2;
  else if (dormantRatio > 0.3) score -= 1;

  if (input.churn_risk_count === 0) score += 1;
  else if (input.churn_risk_count > 20) score -= 1;

  if (score >= 5) return "excellent";
  if (score >= 3) return "good";
  if (score >= 1) return "average";
  if (score >= -1) return "needs_attention";
  return "critical";
}

export function generateExecutiveSummary(
  companyId: string,
  input: ExecutiveSummaryInput
): ExecutiveSummaryResult {
  const now = new Date();
  const rating = computePerformanceRating(input);
  const sections: ExecutiveSummarySection[] = [];
  const keyActions: KeyAction[] = [];

  // Section 1: Revenue Performance
  const revStatus: ExecutiveSummarySection["status"] =
    input.revenue_vs_last_month_pct > 5 ? "positive"
    : input.revenue_vs_last_month_pct > 0 ? "neutral"
    : input.revenue_vs_last_month_pct > -10 ? "warning"
    : "critical";

  sections.push({
    title: "Performa Revenue",
    content: input.revenue_vs_last_month_pct > 0
      ? `Revenue ${input.period_label} sebesar ${formatIDR(input.total_revenue)} — meningkat ${input.revenue_vs_last_month_pct}% dibanding bulan lalu. Tren positif ini didorong oleh ${input.top_areas[0]?.area ?? "area utama"} yang menjadi kontributor order terbesar.`
      : input.revenue_vs_last_month_pct === 0
      ? `Revenue ${input.period_label} sebesar ${formatIDR(input.total_revenue)} — stabil dibanding bulan lalu. Pertahankan momentum dan cari peluang pertumbuhan di area baru.`
      : `Revenue ${input.period_label} sebesar ${formatIDR(input.total_revenue)} — turun ${Math.abs(input.revenue_vs_last_month_pct)}% dari bulan lalu. Evaluasi faktor penyebab dan percepat program reaktivasi reseller.`,
    status: revStatus,
    metrics: [
      { label: "Total Revenue", value: formatIDR(input.total_revenue) },
      { label: "vs Bulan Lalu", value: `${input.revenue_vs_last_month_pct > 0 ? "+" : ""}${input.revenue_vs_last_month_pct}%` },
      { label: "Total Order", value: input.total_orders.toLocaleString("id-ID") },
    ],
  });

  // Section 2: Reseller Health
  const dormantPct = input.total_resellers > 0
    ? Math.round((input.dormant_resellers / input.total_resellers) * 100)
    : 0;
  const resellerStatus: ExecutiveSummarySection["status"] =
    dormantPct < 20 ? "positive"
    : dormantPct < 35 ? "neutral"
    : dormantPct < 50 ? "warning"
    : "critical";

  sections.push({
    title: "Kesehatan Jaringan Reseller",
    content: `Dari ${input.total_resellers} reseller terdaftar, ${input.active_resellers} aktif (${100 - dormantPct}%) dan ${input.dormant_resellers} dormant (${dormantPct}%). Repeat Order Rate ${input.repeat_order_rate}% ${input.repeat_order_rate >= 70 ? "— sangat baik, menunjukkan loyalitas tinggi." : input.repeat_order_rate >= 50 ? "— cukup baik." : "— perlu ditingkatkan dengan program loyalitas."}${input.high_value_dormant > 0 ? ` Perhatian: ${input.high_value_dormant} reseller bernilai tinggi dalam kondisi dormant — risiko revenue loss signifikan.` : ""}`,
    status: resellerStatus,
    metrics: [
      { label: "Reseller Aktif", value: `${input.active_resellers} (${100 - dormantPct}%)` },
      { label: "Dormant", value: `${input.dormant_resellers} (${dormantPct}%)` },
      { label: "Repeat Rate", value: `${input.repeat_order_rate}%` },
    ],
  });

  // Section 3: AI Risk Assessment
  const riskStatus: ExecutiveSummarySection["status"] =
    input.churn_risk_count === 0 ? "positive"
    : input.churn_risk_count <= 10 ? "warning"
    : "critical";

  sections.push({
    title: "AI Risk Assessment",
    content: input.churn_risk_count > 0
      ? `AI mendeteksi ${input.churn_risk_count} reseller dengan risiko churn tinggi (tidak order >45 hari). ${input.never_ordered_count > 0 ? `Selain itu, ${input.never_ordered_count} reseller belum pernah melakukan order sejak didaftarkan.` : ""} Tindakan segera diperlukan untuk meminimalkan revenue loss.`
      : `AI tidak mendeteksi churn risk. Semua reseller menunjukkan pola order yang sehat. ${input.never_ordered_count > 0 ? `Catatan: ${input.never_ordered_count} reseller masih perlu diaktivasi.` : ""}`,
    status: riskStatus,
    metrics: [
      { label: "Churn Risk", value: `${input.churn_risk_count} reseller` },
      { label: "Belum Order", value: `${input.never_ordered_count} reseller` },
      { label: "High Value Dormant", value: `${input.high_value_dormant} reseller` },
    ],
  });

  // Section 4: Forecast
  const forecastStatus: ExecutiveSummarySection["status"] =
    input.forecast_growth_pct > 5 ? "positive"
    : input.forecast_growth_pct > -5 ? "neutral"
    : "warning";

  sections.push({
    title: "Proyeksi Bulan Depan",
    content: `AI memproyeksikan revenue bulan depan sebesar ${formatIDR(input.forecast_next_month)} (${input.forecast_growth_pct > 0 ? "+" : ""}${input.forecast_growth_pct}% dari bulan ini). ${input.forecast_growth_pct > 0 ? "Pertahankan momentum dengan menjaga tingkat aktivitas sales saat ini." : "Diperlukan upaya ekstra untuk membalikkan tren — fokus pada reaktivasi dan akuisisi reseller baru."}`,
    status: forecastStatus,
    metrics: [
      { label: "Proyeksi Bulan Depan", value: formatIDR(input.forecast_next_month) },
      { label: "Pertumbuhan Proyeksi", value: `${input.forecast_growth_pct > 0 ? "+" : ""}${input.forecast_growth_pct}%` },
    ],
  });

  // Key Actions
  if (input.churn_risk_count > 0) {
    keyActions.push({
      priority: "URGENT",
      action: `Jalankan kampanye reaktivasi untuk ${input.churn_risk_count} reseller churn risk`,
      rationale: "Reseller yang churn sangat sulit dimenangkan kembali. Interveni sebelum terlambat.",
      expected_impact: `Potensi mempertahankan ${Math.round(input.churn_risk_count * 0.4)} reseller`,
    });
  }

  if (input.high_value_dormant > 0) {
    keyActions.push({
      priority: "URGENT",
      action: `Kunjungi langsung ${input.high_value_dormant} reseller bernilai tinggi yang dormant`,
      rationale: "Reseller high-value memberikan kontribusi besar. Kehilangan 1 saja berdampak signifikan.",
      expected_impact: `Potensi mempertahankan revenue >Rp${input.high_value_dormant * 5}jt/bulan`,
    });
  }

  if (input.never_ordered_count > 0) {
    keyActions.push({
      priority: "HIGH",
      action: `Aktivasi ${input.never_ordered_count} reseller yang belum pernah order`,
      rationale: "Reseller yang sudah terdaftar adalah prospek paling warm. Konversi pertama adalah kunci.",
      expected_impact: `Potensi tambahan ${input.never_ordered_count} reseller aktif`,
    });
  }

  if (input.forecast_growth_pct < -5) {
    keyActions.push({
      priority: "HIGH",
      action: "Review strategi pricing dan program insentif untuk mendorong pertumbuhan",
      rationale: "Tren negatif perlu diintervensi sebelum momentum semakin menurun.",
      expected_impact: "Membalikkan tren menjadi netral atau positif dalam 2 bulan",
    });
  }

  if (input.repeat_order_rate >= 70) {
    keyActions.push({
      priority: "MEDIUM",
      action: "Implementasikan program referral untuk memanfaatkan loyalitas tinggi",
      rationale: `Repeat Order Rate ${input.repeat_order_rate}% mengindikasikan kepuasan pelanggan yang tinggi — momen tepat untuk referral.`,
      expected_impact: "Target: +10 reseller baru dari referral dalam 1 bulan",
    });
  }

  // Headline
  const ratingLabel = {
    excellent: "Performa Luar Biasa",
    good: "Performa Baik",
    average: "Performa Rata-rata",
    needs_attention: "Perlu Perhatian",
    critical: "Situasi Kritis",
  }[rating];

  const headline = `${ratingLabel} — ${formatIDR(input.total_revenue)} dari ${input.total_orders} order, ${input.active_resellers} reseller aktif`;

  const overallInsight = buildOverallInsight(rating, input);

  return {
    company_id: companyId,
    period: input.period_label,
    generated_at: now.toISOString(),
    headline,
    performance_rating: rating,
    sections,
    key_actions: keyActions,
    overall_insight: overallInsight,
  };
}

function buildOverallInsight(
  rating: ExecutiveSummaryResult["performance_rating"],
  input: ExecutiveSummaryInput
): string {
  const topSalesName = input.top_sales[0]?.name ?? "Tim Sales";
  const topAreaName = input.top_areas[0]?.area ?? "area utama";

  switch (rating) {
    case "excellent":
      return `${input.company_name} dalam kondisi sangat baik. Revenue tumbuh ${input.revenue_vs_last_month_pct}%, reseller aktif tinggi, dan jaringan distribusi sehat. ${topSalesName} menjadi performer terbaik. Area ${topAreaName} memberikan kontribusi order tertinggi. Fokuskan pada ekspansi ke area baru sambil mempertahankan momentum saat ini.`;
    case "good":
      return `${input.company_name} menunjukkan performa baik secara keseluruhan. Ada beberapa area yang perlu diperhatikan, namun fundamental bisnis kuat. Pertahankan ritme kerja tim sales dan lanjutkan program follow-up rutin.`;
    case "average":
      return `${input.company_name} dalam kondisi stabil namun ada peluang untuk tumbuh lebih cepat. Dorong aktivitas sales di area underperforming dan tingkatkan frekuensi follow-up ke reseller dormant.`;
    case "needs_attention":
      return `${input.company_name} memerlukan perhatian. Beberapa indikator kunci di bawah target. Prioritaskan reaktivasi reseller dormant dan perkuat monitoring aktivitas sales harian.`;
    case "critical":
      return `${input.company_name} dalam kondisi yang memerlukan tindakan segera. Revenue dan aktivitas reseller menunjukkan tren yang mengkhawatirkan. Lakukan rapat tim darurat dan susun rencana intervensi dalam 48 jam ke depan.`;
  }
}
