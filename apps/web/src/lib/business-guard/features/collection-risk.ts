// =============================================================================
// Business Guard AI Feature: Collection Risk (piutang berisiko macet)
// Menghitung risiko piutang tak tertagih per customer dari invoice outstanding,
// riwayat janji bayar (promises_to_pay), dan riwayat penagihan (collection_
// activities). Model: rule-based analytics (tanpa LLM), pola sama dengan
// discount-anomaly.ts -- tapi skor berbasis ambang absolut (aging AR standar),
// bukan relatif ke rata-rata peer seperti Sales Risk.
// =============================================================================

export type CollectionRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface OutstandingInvoiceInfo {
  invoice_number: string;
  due_date: string | null;
  outstanding_balance: number;
}

export interface CustomerCollectionActivity {
  customer_id: string;
  customer_name: string;
  outstanding_invoices: OutstandingInvoiceInfo[];
  /** Janji bayar berstatus 'broken' dalam window lookback (dihitung pemanggil). */
  broken_promise_count: number;
  /** Aktivitas penagihan terakhir berstatus 'dispute' belum ada penyelesaian setelahnya. */
  has_unresolved_dispute: boolean;
}

export interface CollectionRiskResult {
  customer_id: string;
  customer_name: string;
  risk_level: CollectionRiskLevel;
  confidence: number; // 0.0 - 1.0
  total_outstanding_amount: number;
  outstanding_invoice_count: number;
  max_age_days: number | null; // null kalau semua invoice tanpa due_date
  broken_promise_count: number;
  has_unresolved_dispute: boolean;
  recommendation: string;
  signals: string[];
}

function ageDays(dueDate: string | null, now: Date): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return null;
  return Math.max(0, Math.floor((now.getTime() - due) / 86_400_000));
}

export function detectCollectionRisk(
  activity: CustomerCollectionActivity,
  now: Date = new Date(),
): CollectionRiskResult {
  const { customer_id, customer_name, outstanding_invoices, broken_promise_count, has_unresolved_dispute } = activity;

  const totalOutstanding = outstanding_invoices.reduce((s, inv) => s + inv.outstanding_balance, 0);
  const ages = outstanding_invoices
    .map((inv) => ageDays(inv.due_date, now))
    .filter((a): a is number => a !== null);
  const maxAgeDays = ages.length > 0 ? Math.max(...ages) : null;

  const signals: string[] = [];
  let riskScore = 0;

  if (outstanding_invoices.length === 0) {
    return {
      customer_id,
      customer_name,
      risk_level: "NONE",
      confidence: 0.9,
      total_outstanding_amount: 0,
      outstanding_invoice_count: 0,
      max_age_days: null,
      broken_promise_count: 0,
      has_unresolved_dispute: false,
      recommendation: "Tidak ada tindakan diperlukan.",
      signals: ["Tidak ada piutang outstanding"],
    };
  }

  // Signal 1: umur piutang terlama (aging) -- sinyal utama risiko macet.
  if (maxAgeDays !== null) {
    if (maxAgeDays > 90) {
      riskScore += 60;
      signals.push(`Piutang tertua sudah lewat jatuh tempo ${maxAgeDays} hari (>90 hari)`);
    } else if (maxAgeDays > 60) {
      riskScore += 40;
      signals.push(`Piutang tertua lewat jatuh tempo ${maxAgeDays} hari (61-90 hari)`);
    } else if (maxAgeDays > 30) {
      riskScore += 20;
      signals.push(`Piutang tertua lewat jatuh tempo ${maxAgeDays} hari (31-60 hari)`);
    }
  } else {
    signals.push("Invoice outstanding tidak punya jatuh tempo tercatat -- umur piutang tidak bisa dihitung");
  }

  // Signal 2: janji bayar yang diingkari (broken promise).
  if (broken_promise_count > 0) {
    riskScore += Math.min(30, broken_promise_count * 15);
    signals.push(
      broken_promise_count === 1
        ? "1 janji bayar sebelumnya diingkari (broken)"
        : `${broken_promise_count} janji bayar sebelumnya diingkari (broken)`,
    );
  }

  // Signal 3: sengketa/dispute yang belum terselesaikan.
  if (has_unresolved_dispute) {
    riskScore += 10;
    signals.push("Ada dispute penagihan yang belum terselesaikan");
  }

  riskScore = Math.min(100, riskScore);

  let risk_level: CollectionRiskLevel;
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
    if (signals.length === 0) signals.push("Piutang masih dalam batas wajar, belum ada tanda risiko macet");
  }

  confidence = Math.min(0.97, confidence);

  return {
    customer_id,
    customer_name,
    risk_level,
    confidence,
    total_outstanding_amount: totalOutstanding,
    outstanding_invoice_count: outstanding_invoices.length,
    max_age_days: maxAgeDays,
    broken_promise_count,
    has_unresolved_dispute,
    recommendation: buildRecommendation(risk_level, customer_name, maxAgeDays, totalOutstanding),
    signals,
  };
}

function buildRecommendation(
  risk: CollectionRiskLevel,
  customerName: string,
  maxAgeDays: number | null,
  totalOutstanding: number,
): string {
  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Hubungi ${customerName} langsung dan pertimbangkan eskalasi (kunjungan lapangan/surat tagihan resmi) -- piutang ${maxAgeDays ?? "?"} hari lewat jatuh tempo, total Rp${Math.round(totalOutstanding).toLocaleString("id-ID")}.`;
  }
  if (risk === "MEDIUM") {
    return `Jadwalkan follow-up penagihan ${customerName} minggu ini sebelum piutang makin menua.`;
  }
  if (risk === "LOW") {
    return `Pantau ${customerName} pada siklus penagihan rutin.`;
  }
  return `Tidak ada tindakan diperlukan.`;
}
