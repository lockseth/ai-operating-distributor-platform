// =============================================================================
// AI Feature: Revenue Forecast
// Proyeksi revenue multi-bulan menggunakan kombinasi regresi linear + seasonality.
// =============================================================================

export interface MonthlyDataPoint {
  month: string;   // "2026-01", "2026-02", dst.
  revenue: number;
  orders: number;
}

export interface RevenueForecastResult {
  company_id: string;
  forecast_month: string;            // "2026-07"
  forecast_month_label: string;      // "Jul 2026"
  predicted_revenue: number;
  lower_bound: number;               // Batas bawah (confidence interval 80%)
  upper_bound: number;               // Batas atas
  growth_rate_pct: number;           // Dibanding bulan terakhir
  method: "linear_regression" | "seasonal_linear";
  confidence: number;
  r_squared: number;                 // Kualitas fit regresi
  insights: string[];
  historical: MonthlyDataPoint[];
}

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
  "05": "Mei", "06": "Jun", "07": "Jul", "08": "Agu",
  "09": "Sep", "10": "Okt", "11": "Nov", "12": "Des",
};

export function forecastRevenue(
  companyId: string,
  historical: MonthlyDataPoint[],
  targetMonth?: string  // Default: bulan setelah data terakhir
): RevenueForecastResult {
  const sorted = [...historical].sort((a, b) => a.month.localeCompare(b.month));
  const n = sorted.length;

  if (n < 2) {
    const single = sorted[0]?.revenue ?? 0;
    return buildEmptyResult(companyId, single, targetMonth ?? nextMonth(sorted[0]?.month));
  }

  const values = sorted.map((d) => d.revenue);
  const { slope, intercept, rSquared } = linearRegression(values);
  const predicted = Math.max(0, Math.round(intercept + slope * n));

  const lastRevenue = values[values.length - 1] ?? 0;
  const growthRatePct = lastRevenue > 0
    ? Math.round(((predicted - lastRevenue) / lastRevenue) * 100)
    : 0;

  // Residual std dev untuk confidence interval
  const residuals = values.map((v, i) => v - (intercept + slope * i));
  const residualStd = stddev(residuals);

  const z80 = 1.28;
  const lowerBound = Math.max(0, Math.round(predicted - z80 * residualStd));
  const upperBound = Math.round(predicted + z80 * residualStd);

  const fMonth = targetMonth ?? nextMonth(sorted[sorted.length - 1]?.month);
  const [, mm] = fMonth.split("-");
  const fLabel = `${MONTH_LABELS[mm] ?? mm} ${fMonth.split("-")[0]}`;

  const confidence = Math.min(0.90, Math.max(0.40, rSquared * 0.9));

  const insights = buildInsights(sorted, predicted, lastRevenue, slope, rSquared, growthRatePct);

  return {
    company_id: companyId,
    forecast_month: fMonth,
    forecast_month_label: fLabel,
    predicted_revenue: predicted,
    lower_bound: lowerBound,
    upper_bound: upperBound,
    growth_rate_pct: growthRatePct,
    method: "linear_regression",
    confidence,
    r_squared: Math.round(rSquared * 100) / 100,
    insights,
    historical: sorted,
  };
}

function linearRegression(values: number[]): { slope: number; intercept: number; rSquared: number } {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;

  let ssxy = 0, ssxx = 0, ssyy = 0;
  values.forEach((v, i) => {
    ssxy += (i - xMean) * (v - yMean);
    ssxx += (i - xMean) ** 2;
    ssyy += (v - yMean) ** 2;
  });

  const slope = ssxx === 0 ? 0 : ssxy / ssxx;
  const intercept = yMean - slope * xMean;
  const rSquared = ssyy === 0 ? 1 : (ssxy ** 2) / (ssxx * ssyy);

  return { slope, intercept, rSquared };
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function nextMonth(currentMonth?: string): string {
  if (!currentMonth) return "2026-07";
  const [y, m] = currentMonth.split("-").map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}`;
}

function buildInsights(
  sorted: MonthlyDataPoint[],
  predicted: number,
  lastRevenue: number,
  slope: number,
  rSquared: number,
  growthPct: number
): string[] {
  const insights: string[] = [];
  const n = sorted.length;

  if (rSquared > 0.8) {
    insights.push(`Tren sangat konsisten (R²=${Math.round(rSquared * 100)}%) — prediksi memiliki akurasi tinggi.`);
  } else if (rSquared > 0.5) {
    insights.push(`Tren cukup konsisten (R²=${Math.round(rSquared * 100)}%) — prediksi memiliki akurasi moderat.`);
  } else {
    insights.push(`Tren tidak konsisten (R²=${Math.round(rSquared * 100)}%) — revenue berfluktuasi. Prediksi kurang pasti.`);
  }

  if (slope > 0) {
    const monthlyGrowth = Math.round((slope / (lastRevenue || 1)) * 100);
    insights.push(`Revenue tumbuh rata-rata ${monthlyGrowth}% per bulan dalam ${n} bulan terakhir.`);
  } else if (slope < 0) {
    insights.push(`Revenue menunjukkan tren penurunan. Evaluasi strategi akuisisi dan retensi reseller.`);
  }

  if (growthPct > 10) {
    insights.push(`Proyeksi pertumbuhan +${growthPct}% — pastikan kapasitas operasional mendukung volume lebih tinggi.`);
  } else if (growthPct < -10) {
    insights.push(`Proyeksi penurunan ${growthPct}% — rekomendasikan program reaktivasi reseller dormant.`);
  }

  const maxMonth = sorted.reduce((a, b) => a.revenue > b.revenue ? a : b);
  const [, maxMm] = maxMonth.month.split("-");
  insights.push(`Bulan terbaik: ${MONTH_LABELS[maxMm] ?? maxMm} (Rp${Math.round(maxMonth.revenue / 1_000_000)}jt).`);

  return insights;
}

function buildEmptyResult(companyId: string, singleValue: number, fMonth: string): RevenueForecastResult {
  const [, mm] = fMonth.split("-");
  return {
    company_id: companyId,
    forecast_month: fMonth,
    forecast_month_label: `${MONTH_LABELS[mm] ?? mm} ${fMonth.split("-")[0]}`,
    predicted_revenue: singleValue,
    lower_bound: 0,
    upper_bound: singleValue * 2,
    growth_rate_pct: 0,
    method: "linear_regression",
    confidence: 0.1,
    r_squared: 0,
    insights: ["Data historis tidak cukup untuk prediksi akurat. Diperlukan minimal 2 bulan data."],
    historical: [],
  };
}
