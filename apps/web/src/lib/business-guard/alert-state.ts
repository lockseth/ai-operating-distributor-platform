// =============================================================================
// Business Guard AI: Alert State (Gate P4.20) -- anti-spam untuk push WA.
// Semua 6 fitur Business Guard sebelumnya 100% pull-only, dan 2 yang sempat
// masuk brief WA harian (Gate P4.18 Unremitted Collection, Gate P4.19 Call
// Timing) tidak punya anti-spam -- entitas yang tetap HIGH berhari-hari akan
// muncul di WA setiap hari, melatih Owner mengabaikan pesan.
//
// SATU-SATUNYA state persisten di Business Guard (5 fitur lain SELECT+JS
// murni). Ditulis HANYA dari route automation internal (admin client),
// TIDAK PERNAH dari /dashboard/risk (page itu tetap pure read, zero side
// effect) -- state-write terikat ke momen benar-benar mengirim WA, bukan ke
// momen halaman dibuka.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type BusinessGuardRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type BusinessGuardAlertType =
  | "discount_anomaly"
  | "collection_risk"
  | "behavior_change"
  | "transaction_risk"
  | "unremitted_collection"
  | "call_timing_anomaly";

export interface PreviousAlertState {
  lastNotifiedRiskLevel: BusinessGuardRiskLevel | null;
}

export interface AlertNotificationDecision {
  shouldNotify: boolean;
  /** Nilai yang harus disimpan sebagai last_notified_risk_level setelah keputusan ini. */
  nextLastNotifiedRiskLevel: BusinessGuardRiskLevel | null;
}

/**
 * Aturan transisi: notifikasi SEKALI saat level saat ini notify-worthy DAN
 * beda dari level yang TERAKHIR dinotifikasi. Diam selama levelnya sama.
 * Keluar dari zona notify-worthy (turun ke level yang tidak dipantau fitur
 * ini) SELALU me-reset ke null -- supaya masuk lagi ke zona nanti dihitung
 * kejadian baru, bukan "sudah pernah dinotifikasi". Baris reset inilah yang
 * membuat HIGH->NONE->HIGH dan HIGH->MEDIUM->HIGH sama-sama benar lewat
 * code path yang sama, terlepas apakah MEDIUM notify-worthy untuk fitur ini.
 */
export function decideAlertNotification(
  currentRiskLevel: BusinessGuardRiskLevel,
  previous: PreviousAlertState | null,
  notifiableLevels: readonly BusinessGuardRiskLevel[] = ["HIGH"],
): AlertNotificationDecision {
  const isNotifyWorthy = notifiableLevels.includes(currentRiskLevel);
  const lastNotified = previous?.lastNotifiedRiskLevel ?? null;

  if (!isNotifyWorthy) {
    return { shouldNotify: false, nextLastNotifiedRiskLevel: null };
  }
  if (currentRiskLevel === lastNotified) {
    return { shouldNotify: false, nextLastNotifiedRiskLevel: lastNotified };
  }
  return { shouldNotify: true, nextLastNotifiedRiskLevel: currentRiskLevel };
}

export function callTimingEntityKey(salespersonId: string, callDate: string): string {
  return `${salespersonId}:${callDate}`;
}

export interface AlertEvaluationInput<T> {
  entityKey: string;
  riskLevel: BusinessGuardRiskLevel;
  payload: T;
}

export interface AlertEvaluationResult<T> {
  entityKey: string;
  riskLevel: BusinessGuardRiskLevel;
  payload: T;
  shouldNotify: boolean;
}

type AlertStateRow = {
  entity_key: string;
  last_risk_level: BusinessGuardRiskLevel;
  last_notified_risk_level: BusinessGuardRiskLevel | null;
  last_notified_at: string | null;
  first_seen_high_at: string | null;
};

/**
 * Evaluasi + persist state untuk SATU alert_type dalam satu run. `evaluations`
 * WAJIB daftar LENGKAP (semua level, bukan pre-filtered) -- supaya transisi
 * turun ke NONE/LOW bisa tercatat (reset), bukan cuma entitas yang sedang
 * notify-worthy.
 *
 * Closure entitas yang hilang dari `evaluations` (mis. collection-risk:
 * customer yang lunas hilang total dari laporan) -- baris existing yang
 * entity_key-nya TIDAK ada di `evaluations` hari ini dievaluasi sintetis
 * sebagai NONE (reset), TAPI tidak masuk hasil return (tidak punya payload).
 * Tanpa ini, customer yang lunas lalu nunggak lagi sampai HIGH akan salah
 * dianggap "sudah pernah dinotifikasi" dan diam padahal harusnya notify.
 *
 * Skip write untuk entitas yang TIDAK punya baris existing DAN levelnya
 * sekarang tidak notify-worthy -- supaya tabel tetap terbatas ke entitas
 * yang PERNAH notify-worthy, bukan seluruh roster aktif (penting untuk
 * discount-anomaly/behavior-change yang selalu kirim roster penuh tiap run).
 *
 * `supabase` WAJIB admin client (service role) -- dipanggil HANYA dari route
 * automation internal yang sudah lolos scope-check credential sebelum kode
 * ini jalan. company_id difilter eksplisit di setiap query/payload karena
 * admin client bypass RLS total.
 */
export async function evaluateAndPersistAlertState<T>(
  supabase: SupabaseClient,
  companyId: string,
  alertType: BusinessGuardAlertType,
  evaluations: AlertEvaluationInput<T>[],
  notifiableLevels: readonly BusinessGuardRiskLevel[] = ["HIGH"],
  now: Date = new Date(),
): Promise<AlertEvaluationResult<T>[]> {
  const { data: existingRows } = await supabase
    .from("business_guard_alert_state")
    .select("entity_key, last_risk_level, last_notified_risk_level, last_notified_at, first_seen_high_at")
    .eq("company_id", companyId)
    .eq("alert_type", alertType);

  const existingByKey = new Map<string, AlertStateRow>(
    ((existingRows ?? []) as AlertStateRow[]).map((r) => [r.entity_key, r]),
  );

  const evaluatedKeys = new Set(evaluations.map((e) => e.entityKey));
  const closureEntityKeys = [...existingByKey.keys()].filter((k) => !evaluatedKeys.has(k));

  const nowIso = now.toISOString();
  const results: AlertEvaluationResult<T>[] = [];
  const rowsToUpsert: Record<string, unknown>[] = [];

  for (const evalItem of evaluations) {
    const existing = existingByKey.get(evalItem.entityKey) ?? null;
    const decision = decideAlertNotification(
      evalItem.riskLevel,
      existing ? { lastNotifiedRiskLevel: existing.last_notified_risk_level } : null,
      notifiableLevels,
    );

    results.push({
      entityKey: evalItem.entityKey,
      riskLevel: evalItem.riskLevel,
      payload: evalItem.payload,
      shouldNotify: decision.shouldNotify,
    });

    const isNotifyWorthy = notifiableLevels.includes(evalItem.riskLevel);
    if (!existing && !isNotifyWorthy) continue; // tidak perlu baris baru

    const wasHigh = existing?.last_risk_level === "HIGH";
    const nowHigh = evalItem.riskLevel === "HIGH";
    const firstSeenHighAt = nowHigh ? (wasHigh ? existing!.first_seen_high_at : nowIso) : null;

    rowsToUpsert.push({
      company_id: companyId,
      alert_type: alertType,
      entity_key: evalItem.entityKey,
      last_risk_level: evalItem.riskLevel,
      last_notified_risk_level: decision.nextLastNotifiedRiskLevel,
      last_notified_at: decision.shouldNotify ? nowIso : (existing?.last_notified_at ?? null),
      first_seen_high_at: firstSeenHighAt,
      last_evaluated_at: nowIso,
    });
  }

  for (const entityKey of closureEntityKeys) {
    const existing = existingByKey.get(entityKey)!;
    const decision = decideAlertNotification(
      "NONE",
      { lastNotifiedRiskLevel: existing.last_notified_risk_level },
      notifiableLevels,
    );
    rowsToUpsert.push({
      company_id: companyId,
      alert_type: alertType,
      entity_key: entityKey,
      last_risk_level: "NONE",
      last_notified_risk_level: decision.nextLastNotifiedRiskLevel,
      last_notified_at: existing.last_notified_at,
      first_seen_high_at: null,
      last_evaluated_at: nowIso,
    });
  }

  if (rowsToUpsert.length > 0) {
    await supabase
      .from("business_guard_alert_state")
      .upsert(rowsToUpsert, { onConflict: "company_id,alert_type,entity_key" });
  }

  return results;
}
