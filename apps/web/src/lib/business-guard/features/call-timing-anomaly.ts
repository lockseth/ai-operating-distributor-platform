// =============================================================================
// Business Guard AI Feature: Suspicious Call Timing (Gate P4.19)
// Sales mencatat kunjungan toko ("Call") lewat Telegram tanpa foto/GPS -- cuma
// catatan teks bebas minimal 3 karakter (lihat record_sales_call RPC). Celah:
// kunjungan bisa sepenuhnya dikarang dan tetap terhitung Effective Call kalau
// disertai order confirmed. Sinyal ini menangkap pola waktu yang secara fisik
// tidak masuk akal -- jarak sekian puluh detik antar-call berurutan dalam satu
// hari, terlalu singkat untuk benar-benar berpindah toko.
//
// Deteksi & ALERT saja -- TIDAK memblokir apa pun, TIDAK menyentuh definisi
// KPI Call/Effective Call yang LOCKED (keputusan Founder 2026-08-23, celah #2
// audit fraud protection). occurred_at TIDAK BISA dipalsukan pemanggil --
// record_sales_call tidak pernah menerima parameter timestamp.
//
// PENTING: pasangan call yang waktunya rapat TIDAK SELALU berarti customer
// berbeda -- uq_sales_calls_one_per_day hanya memblokir duplikat customer+hari
// yang TIDAK diotorisasi (authorization_task_id IS NULL). Kunjungan ulang yang
// diotorisasi manager bisa menghasilkan 2 call VALID ke customer SAMA di hari
// yang sama. Fungsi ini TIDAK mensyaratkan customer_a !== customer_b.
// =============================================================================

export type CallTimingRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface SalesCallTimingInput {
  call_id: string;
  customer_id: string;
  customer_name: string;
  occurred_at: string; // ISO timestamp
}

export interface SalesDayCallActivity {
  salesperson_id: string;
  salesperson_name: string;
  call_date: string; // YYYY-MM-DD
  /** Pemanggil sudah filter status='VALID' AND coverage_basis Telegram (ASSIGNED/AREA/EXCEPTION). */
  calls: SalesCallTimingInput[];
}

export interface FlaggedCallPair {
  customer_a: string;
  customer_b: string;
  gap_seconds: number;
}

export interface SalesCallTimingResult {
  salesperson_id: string;
  salesperson_name: string;
  call_date: string;
  total_calls: number;
  min_gap_seconds: number | null;
  severe_gap_count: number; // gap < 60s
  tight_gap_count: number; // gap < 120s (termasuk severe)
  risk_level: CallTimingRiskLevel;
  confidence: number;
  recommendation: string;
  signals: string[];
  flagged_pairs: FlaggedCallPair[]; // hanya pasangan gap < 120s
}

const SEVERE_GAP_SECONDS = 60;
const TIGHT_GAP_SECONDS = 120;

export function detectSuspiciousCallTiming(
  activity: SalesDayCallActivity,
  now: Date = new Date(),
): SalesCallTimingResult {
  const { salesperson_id, salesperson_name, call_date, calls } = activity;
  const totalCalls = calls.length;

  const signals: string[] = [];
  const flaggedPairs: FlaggedCallPair[] = [];

  if (totalCalls < 2) {
    return {
      salesperson_id,
      salesperson_name,
      call_date,
      total_calls: totalCalls,
      min_gap_seconds: null,
      severe_gap_count: 0,
      tight_gap_count: 0,
      risk_level: "NONE",
      confidence: 0.7,
      recommendation: "Tidak ada tindakan diperlukan.",
      signals: ["Kurang dari 2 kunjungan tercatat hari ini -- tidak ada jarak waktu untuk dinilai"],
      flagged_pairs: [],
    };
  }

  const sorted = [...calls].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );

  let minGapSeconds = Infinity;
  let severeGapCount = 0;
  let tightGapCount = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const gapSeconds = Math.round(
      (new Date(curr.occurred_at).getTime() - new Date(prev.occurred_at).getTime()) / 1000,
    );

    if (gapSeconds < minGapSeconds) minGapSeconds = gapSeconds;
    if (gapSeconds < SEVERE_GAP_SECONDS) severeGapCount += 1;
    if (gapSeconds < TIGHT_GAP_SECONDS) {
      tightGapCount += 1;
      flaggedPairs.push({ customer_a: prev.customer_id, customer_b: curr.customer_id, gap_seconds: gapSeconds });
    }
  }

  let riskScore = 0;

  // Sinyal A: gap terketat dalam sehari.
  if (minGapSeconds < SEVERE_GAP_SECONDS) {
    riskScore += 40;
    signals.push(`Jarak waktu terketat antar-kunjungan cuma ${minGapSeconds} detik -- tidak masuk akal berpindah toko`);
  } else if (minGapSeconds < TIGHT_GAP_SECONDS) {
    riskScore += 22;
    signals.push(`Jarak waktu terketat antar-kunjungan ${minGapSeconds} detik -- sangat singkat untuk berpindah toko`);
  }

  // Sinyal B: pengulangan gap rapat.
  if (tightGapCount >= 4) {
    riskScore += 30;
    signals.push(`${tightGapCount} pasang kunjungan berurutan dengan jarak di bawah 2 menit hari ini`);
  } else if (tightGapCount >= 2) {
    riskScore += 15;
    signals.push(`${tightGapCount} pasang kunjungan berurutan dengan jarak di bawah 2 menit hari ini`);
  }

  riskScore = Math.min(100, riskScore);

  let risk_level: CallTimingRiskLevel;
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
    signals.push("Jarak waktu antar-kunjungan dalam pola wajar");
  }

  confidence = Math.min(0.97, confidence);

  return {
    salesperson_id,
    salesperson_name,
    call_date,
    total_calls: totalCalls,
    min_gap_seconds: minGapSeconds,
    severe_gap_count: severeGapCount,
    tight_gap_count: tightGapCount,
    risk_level,
    confidence,
    recommendation: buildRecommendation(risk_level, salesperson_name, call_date, minGapSeconds, tightGapCount, now),
    signals,
    flagged_pairs: flaggedPairs,
  };
}

function buildRecommendation(
  risk: CallTimingRiskLevel,
  salespersonName: string,
  callDate: string,
  minGapSeconds: number,
  tightGapCount: number,
  now: Date,
): string {
  const isToday = callDate === now.toISOString().slice(0, 10);
  const whenLabel = isToday ? "hari ini" : `tanggal ${callDate}`;

  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Cek langsung ke ${salespersonName} soal kunjungan ${whenLabel} -- jarak terketat cuma ${minGapSeconds} detik antar-toko, ${tightGapCount} pasang di bawah 2 menit.`;
  }
  if (risk === "MEDIUM") {
    return `Tinjau catatan kunjungan ${salespersonName} ${whenLabel} -- ada pola jarak waktu yang terlalu singkat antar-toko.`;
  }
  if (risk === "LOW") {
    return `Kunjungan ${salespersonName} ${whenLabel} sedikit di luar kebiasaan waktu tempuh -- pantau saja.`;
  }
  return "Tidak ada tindakan diperlukan.";
}
