// =============================================================================
// Business Guard AI Feature: Unremitted Collection Risk (Gate P4.18)
// Menangkap sales/collector yang MELAPORKAN sudah menerima pembayaran
// (collection_activities.outcome IN claimed_paid_full/claimed_paid_partial)
// tapi TIDAK PERNAH mengajukan payment_claims resmi untuk itu -- celah cash
// bisa "hilang" tanpa jejak yang diaudit CTO 2026-08-23. Model: rule-based
// (tanpa LLM), pola sama dengan collection-risk.ts.
//
// Deteksi & ALERT saja -- TIDAK memblokir order/aksi apa pun (beda dari
// Gate P4.16). "matched" di sini berarti "klaim pembayaran DITEMUKAN", BUKAN
// "jumlahnya sudah terverifikasi benar" -- pencocokan nominal sengaja di luar
// scope v1 (lihat header matchUnremittedClaims).
// =============================================================================

export type UnremittedCollectionRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface ClaimedActivityInput {
  activity_id: string;
  customer_id: string;
  customer_name: string;
  collector_id: string;
  collector_name: string;
  outcome: "claimed_paid_full" | "claimed_paid_partial";
  reported_amount: number | null;
  occurred_at: string; // ISO timestamp
}

export interface PaymentClaimInput {
  claim_id: string;
  customer_id: string;
  claimed_by: string; // user id -- dicocokkan ke collector_id di atas
  claimed_at: string; // ISO timestamp
}

export interface MatchedClaimedActivity extends ClaimedActivityInput {
  matched: boolean;
  matched_claim_id: string | null;
}

export interface UnremittedCollectionResult {
  activity_id: string;
  customer_id: string;
  customer_name: string;
  collector_id: string;
  collector_name: string;
  outcome: "claimed_paid_full" | "claimed_paid_partial";
  reported_amount: number | null;
  occurred_at: string;
  days_elapsed: number;
  matched: boolean;
  risk_level: UnremittedCollectionRiskLevel;
  confidence: number;
  recommendation: string;
  signals: string[];
}

/**
 * Cocokkan setiap "klaim sudah terima pembayaran" (collection_activities)
 * dengan payment_claims yang benar-benar diajukan -- greedy chronological
 * 1:1 CONSUMPTION per (customer_id, collector/claimed_by user), BUKAN
 * `EXISTS` check. `EXISTS` naif punya false-negative fatal: satu
 * payment_claims asli bisa "membersihkan" berkali-kali klaim collection_
 * activities berbeda tanpa pernah benar-benar dikonsumsi -- persis pola
 * fraud yang mau ditangkap, lolos diam-diam.
 *
 * Grouping pakai customer_id + user yang sama (collector_id == claimed_by),
 * BUKAN invoice_id -- payment_claims.claimed_invoice_ids opsional/
 * informational saja, bukan FK reliable (lihat migration 20261012000001).
 *
 * Status payment_claims (PENDING/APPROVED/REJECTED) TIDAK difilter -- semua
 * dianggap "matched". Pertanyaan fitur ini murni "apakah pernah dilaporkan",
 * bukan "apakah disetujui" (itu urusan Payment Claims Review page).
 *
 * TIDAK ada pencocokan nominal -- kalau collector klaim Rp5jt tapi payment_
 * claims yang diajukan cuma Rp500rb, tetap terhitung "matched" (celah v2
 * yang disengaja).
 */
export function matchUnremittedClaims(
  activities: ClaimedActivityInput[],
  claims: PaymentClaimInput[],
): MatchedClaimedActivity[] {
  const groupKey = (customerId: string, userId: string): string => `${customerId}:${userId}`;

  const claimsByGroup = new Map<string, PaymentClaimInput[]>();
  for (const claim of claims) {
    const key = groupKey(claim.customer_id, claim.claimed_by);
    const list = claimsByGroup.get(key);
    if (list) list.push(claim);
    else claimsByGroup.set(key, [claim]);
  }
  for (const list of claimsByGroup.values()) {
    list.sort((a, b) => new Date(a.claimed_at).getTime() - new Date(b.claimed_at).getTime());
  }

  const consumedClaimIds = new Set<string>();

  // Proses activity dari yang PALING TUA dulu -- greedy-exchange: mengambil
  // claim paling awal yang masih tersedia untuk activity tertua selalu
  // menghasilkan jumlah match maksimal (properti standar interval matching
  // satu-arah "claim harus di ATAU setelah activity").
  const sortedActivities = [...activities].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );

  const resultByActivityId = new Map<string, MatchedClaimedActivity>();

  for (const activity of sortedActivities) {
    const key = groupKey(activity.customer_id, activity.collector_id);
    const candidateClaims = claimsByGroup.get(key) ?? [];
    const occurredAtMs = new Date(activity.occurred_at).getTime();

    let matchedClaimId: string | null = null;
    for (const claim of candidateClaims) {
      if (consumedClaimIds.has(claim.claim_id)) continue;
      if (new Date(claim.claimed_at).getTime() >= occurredAtMs) {
        matchedClaimId = claim.claim_id;
        break;
      }
    }

    if (matchedClaimId) consumedClaimIds.add(matchedClaimId);

    resultByActivityId.set(activity.activity_id, {
      ...activity,
      matched: matchedClaimId !== null,
      matched_claim_id: matchedClaimId,
    });
  }

  // Kembalikan dalam urutan input asli (bukan urutan proses internal) supaya
  // pemanggil dapat hasil yang predictable terhadap array yang dikirim.
  return activities.map((a) => resultByActivityId.get(a.activity_id)!);
}

const MEDIUM_START_DAYS = 3;
const HIGH_START_DAYS = 7;

function daysElapsedSince(occurredAt: string, now: Date): number {
  const occurred = new Date(occurredAt).getTime();
  return Math.max(0, Math.floor((now.getTime() - occurred) / 86_400_000));
}

/**
 * risk_level "LOW" sengaja TIDAK PERNAH dipakai -- cuma dua ambang (3 hari,
 * 7 hari), bukan tiga. Tipe tetap union 4-level untuk konsistensi struktural
 * dengan UnifiedRiskAlert di /dashboard/risk (semua fitur Business Guard
 * lain pakai union yang sama).
 */
export function detectUnremittedCollectionRisk(
  activity: MatchedClaimedActivity,
  now: Date = new Date(),
): UnremittedCollectionResult {
  const daysElapsed = daysElapsedSince(activity.occurred_at, now);
  const signals: string[] = [];
  let risk_level: UnremittedCollectionRiskLevel;
  let confidence: number;

  if (activity.matched) {
    risk_level = "NONE";
    confidence = 0.9;
    signals.push("Klaim pembayaran sudah diajukan untuk pelaporan ini");
  } else if (daysElapsed < MEDIUM_START_DAYS) {
    risk_level = "NONE";
    confidence = 0.6;
    signals.push(`Baru ${daysElapsed} hari sejak dilaporkan -- masih dalam masa tenggang wajar`);
  } else if (daysElapsed < HIGH_START_DAYS) {
    const riskScore = 40;
    risk_level = "MEDIUM";
    confidence = 0.65 + (riskScore - 35) / 250;
    signals.push(`${daysElapsed} hari sejak melaporkan sudah menerima pembayaran, belum ada klaim pembayaran resmi diajukan`);
  } else {
    const riskScore = Math.min(100, 65 + (daysElapsed - HIGH_START_DAYS) * 3);
    risk_level = "HIGH";
    confidence = 0.85 + (riskScore - 60) / 400;
    signals.push(`${daysElapsed} hari sejak melaporkan sudah menerima pembayaran, TIDAK ADA klaim pembayaran resmi diajukan`);
  }

  confidence = Math.min(0.97, confidence);

  return {
    activity_id: activity.activity_id,
    customer_id: activity.customer_id,
    customer_name: activity.customer_name,
    collector_id: activity.collector_id,
    collector_name: activity.collector_name,
    outcome: activity.outcome,
    reported_amount: activity.reported_amount,
    occurred_at: activity.occurred_at,
    days_elapsed: daysElapsed,
    matched: activity.matched,
    risk_level,
    confidence,
    recommendation: buildRecommendation(risk_level, activity, daysElapsed),
    signals,
  };
}

function buildRecommendation(
  risk: UnremittedCollectionRiskLevel,
  activity: MatchedClaimedActivity,
  daysElapsed: number,
): string {
  const amountLabel =
    activity.reported_amount != null
      ? `Rp${Math.round(activity.reported_amount).toLocaleString("id-ID")}`
      : "nominal tidak dicatat";

  if (risk === "HIGH") {
    return `PRIORITAS TINGGI: Tanyakan langsung ke ${activity.collector_name} soal pembayaran ${activity.customer_name} (${amountLabel}, ${daysElapsed} hari lalu) -- belum ada klaim pembayaran resmi diajukan sama sekali.`;
  }
  if (risk === "MEDIUM") {
    return `Follow-up ${activity.collector_name} soal status pembayaran ${activity.customer_name} (${amountLabel}) -- belum ada klaim pembayaran diajukan.`;
  }
  if (activity.matched) {
    return `Tidak ada tindakan diperlukan -- klaim pembayaran ditemukan (bukan berarti nominalnya sudah terverifikasi benar).`;
  }
  return `Masih dalam masa tenggang wajar, pantau saja.`;
}
