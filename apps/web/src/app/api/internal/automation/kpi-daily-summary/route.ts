// =============================================================================
// Internal Automation API -- generate KPI Daily Summary untuk Owner. Channel
// 'whatsapp', dikirim nyata lewat Bablast begitu BABLAST_DRY_RUN=false DAN
// BABLAST_API_KEY tersedia (Gate P4.13) -- sebelum itu tetap dry-run/
// structured preview yang bisa diaudit di automation_outbox.payload (lihat
// /dispatch route).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";
import { SupabaseSalesmanDirectory } from "@/lib/n8n-automation/salesman-directory";
import {
  buildKpiDailySummary,
  kpiDailySummaryIdempotencyKey,
  type KpiDailySummaryChurnCandidate,
  type KpiDailySummaryUnremittedCandidate,
  type KpiDailySummaryCallTimingCandidate,
  type KpiDailySummaryDiscountAnomalyCandidate,
  type KpiDailySummaryCollectionRiskCandidate,
  type KpiDailySummaryBehaviorChangeCandidate,
  type KpiDailySummaryTransactionRiskCandidate,
} from "@/lib/n8n-automation/kpi-daily-summary";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { SupabaseSalesKpiRepository } from "@/lib/sales-kpi/repository";
import { normalizeIndonesianPhone } from "@/lib/integrations/bablast";
import { getChurnCandidatesForCompany } from "@/lib/ai/insights-engine";
import {
  getUnremittedCollectionCandidates,
  getSuspiciousCallTimingCandidates,
  getDiscountAnomalyCandidates,
  getCollectionRiskCandidates,
  getBehaviorChangeCandidates,
  getTransactionRiskCandidates,
} from "@/lib/business-guard/engine";
import { evaluateAndPersistAlertState, callTimingEntityKey } from "@/lib/business-guard/alert-state";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const REQUIRED_SCOPE = "automation.kpi_summary.generate";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-kpi-summary:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const admin = getAdminClient();
    const repository = new SupabaseAutomationRepository(admin);
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!credential.scope.includes(REQUIRED_SCOPE)) {
      return NextResponse.json({ error: `Forbidden: credential missing ${REQUIRED_SCOPE} scope` }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { business_date?: unknown };
    const businessDate =
      typeof body.business_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.business_date)
        ? body.business_date
        : businessDateJakarta();

    const { data: companyRow } = await admin
      .from("companies")
      .select("name")
      .eq("id", credential.companyId)
      .maybeSingle();
    const tenantName = (companyRow as { name: string } | null)?.name ?? "AODP";

    const directory = new SupabaseSalesmanDirectory(admin);
    const owner = await directory.findActiveOwnerRecipient(credential.companyId);

    if (!owner) {
      return NextResponse.json({ error: "No active owner found for tenant" }, { status: 422 });
    }
    const ownerPhone = owner.phone ? normalizeIndonesianPhone(owner.phone) : null;
    if (!ownerPhone) {
      return NextResponse.json({ error: "Owner belum mengisi nomor telepon valid -- laporan tidak punya tujuan kirim" }, { status: 422 });
    }

    const salesKpiRepository = new SupabaseSalesKpiRepository(admin);
    const activePeriod = await salesKpiRepository.findActivePeriod(credential.companyId);

    const recipients = await directory.listEligibleMorningBriefRecipients(credential.companyId);

    const lines = [];
    if (activePeriod) {
      for (const recipient of recipients) {
        const projectionResult = await salesKpiRepository.getAchievementProjection({
          companyId: credential.companyId,
          actorId: credential.id,
          periodId: activePeriod.id,
          salespersonId: recipient.userId,
        });
        lines.push({
          salesmanFullName: recipient.fullName,
          projection: projectionResult.outcome === "ok" ? projectionResult.projection : null,
        });
      }
    }

    // Gate P4.17: calon churn (HIGH/MEDIUM) ikut ditampilkan di brief Owner --
    // kegagalan di sini ditelan (best-effort, TIDAK memblokir KPI Daily
    // Summary yang sudah PASS lama sekiranya query churn error).
    let churnCandidates: KpiDailySummaryChurnCandidate[] = [];
    try {
      const churnPredictions = await getChurnCandidatesForCompany(credential.companyId, admin);
      churnCandidates = churnPredictions
        .filter((p) => p.risk_level === "HIGH" || p.risk_level === "MEDIUM")
        .sort((a, b) => (a.risk_level === b.risk_level ? 0 : a.risk_level === "HIGH" ? -1 : 1))
        .map((p) => ({
          customerName: p.customer_name,
          riskLevel: p.risk_level,
          daysSinceLastOrder: p.days_since_last_order,
        }));
    } catch (churnErr) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung churn candidates (diabaikan):", churnErr);
    }

    // Gate P4.18 + P4.20: klaim "sudah terima pembayaran" yang belum
    // diformalkan jadi klaim pembayaran resmi (HIGH/MEDIUM) -- best-effort,
    // tidak boleh memblokir KPI Daily Summary yang sudah ada. Sejak Gate
    // P4.20, ambang HIGH/MEDIUM DAN anti-spam (jangan kirim ulang tiap hari
    // selama masih di level yang sama) sama-sama ditangani
    // evaluateAndPersistAlertState -- route ini tidak lagi filter risk_level
    // manual, cuma filter shouldNotify.
    let unremittedCandidates: KpiDailySummaryUnremittedCandidate[] = [];
    try {
      const unremittedResults = await getUnremittedCollectionCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "unremitted_collection",
        unremittedResults.map((r) => ({ entityKey: r.activity_id, riskLevel: r.risk_level, payload: r })),
        ["HIGH", "MEDIUM"],
      );
      unremittedCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .sort((a, b) => (a.risk_level === b.risk_level ? 0 : a.risk_level === "HIGH" ? -1 : 1))
        .map((r) => ({
          collectorName: r.collector_name,
          customerName: r.customer_name,
          riskLevel: r.risk_level,
          daysElapsed: r.days_elapsed,
        }));
    } catch (unremittedErr) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung unremitted collection candidates (diabaikan):", unremittedErr);
    }

    // Gate P4.19 + P4.20: hari kunjungan dengan jarak waktu antar-toko
    // mencurigakan -- HANYA HIGH yang ikut brief (heuristik, bukan fakta
    // terkonfirmasi seperti unremitted). Anti-spam sejak Gate P4.20 sama
    // pola dengan unremitted di atas.
    let callTimingCandidates: KpiDailySummaryCallTimingCandidate[] = [];
    try {
      const callTimingResults = await getSuspiciousCallTimingCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "call_timing_anomaly",
        callTimingResults.map((r) => ({
          entityKey: callTimingEntityKey(r.salesperson_id, r.call_date),
          riskLevel: r.risk_level,
          payload: r,
        })),
        ["HIGH"],
      );
      callTimingCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .map((r) => ({
          salespersonName: r.salesperson_name,
          callDate: r.call_date,
          riskLevel: r.risk_level,
          minGapSeconds: r.min_gap_seconds,
          tightGapCount: r.tight_gap_count,
        }));
    } catch (callTimingErr) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung call timing candidates (diabaikan):", callTimingErr);
    }

    // Gate P4.20: 4 fitur Business Guard yang baru pertama kali dapat jalur
    // WA -- HIGH saja untuk keempatnya (heuristik/relatif, konsisten
    // callTimingCandidates), anti-spam pola sama 2 blok di atas.
    let discountAnomalyCandidates: KpiDailySummaryDiscountAnomalyCandidate[] = [];
    try {
      const results = await getDiscountAnomalyCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "discount_anomaly",
        results.map((r) => ({ entityKey: r.sales_id, riskLevel: r.risk_level, payload: r })),
        ["HIGH"],
      );
      discountAnomalyCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .map((r) => ({
          salesName: r.sales_name,
          riskLevel: r.risk_level,
          totalRequests: r.total_requests,
          rejectionRate: r.rejection_rate,
        }));
    } catch (err) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung discount anomaly candidates (diabaikan):", err);
    }

    let collectionRiskCandidates: KpiDailySummaryCollectionRiskCandidate[] = [];
    try {
      const results = await getCollectionRiskCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "collection_risk",
        results.map((r) => ({ entityKey: r.customer_id, riskLevel: r.risk_level, payload: r })),
        ["HIGH"],
      );
      collectionRiskCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .map((r) => ({
          customerName: r.customer_name,
          riskLevel: r.risk_level,
          totalOutstandingAmount: r.total_outstanding_amount,
          maxAgeDays: r.max_age_days,
        }));
    } catch (err) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung collection risk candidates (diabaikan):", err);
    }

    let behaviorChangeCandidates: KpiDailySummaryBehaviorChangeCandidate[] = [];
    try {
      const results = await getBehaviorChangeCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "behavior_change",
        results.map((r) => ({ entityKey: r.customer_id, riskLevel: r.risk_level, payload: r })),
        ["HIGH"],
      );
      behaviorChangeCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .map((r) => ({
          customerName: r.customer_name,
          riskLevel: r.risk_level,
          daysSinceLastOrder: r.days_since_last_order,
        }));
    } catch (err) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung behavior change candidates (diabaikan):", err);
    }

    let transactionRiskCandidates: KpiDailySummaryTransactionRiskCandidate[] = [];
    try {
      const results = await getTransactionRiskCandidates(credential.companyId, admin);
      const evaluated = await evaluateAndPersistAlertState(
        admin,
        credential.companyId,
        "transaction_risk",
        results.map((r) => ({ entityKey: r.order_id, riskLevel: r.risk_level, payload: r })),
        ["HIGH"],
      );
      transactionRiskCandidates = evaluated
        .filter((e) => e.shouldNotify)
        .map((e) => e.payload)
        .map((r) => ({
          orderNumber: r.order_number,
          customerName: r.customer_name,
          riskLevel: r.risk_level,
          orderTotalAmount: r.order_total_amount,
        }));
    } catch (err) {
      console.error("[Internal Automation /kpi-daily-summary] gagal hitung transaction risk candidates (diabaikan):", err);
    }

    const content = buildKpiDailySummary({
      tenantName,
      businessDate,
      activePeriod,
      lines,
      churnCandidates,
      unremittedCandidates,
      callTimingCandidates,
      discountAnomalyCandidates,
      collectionRiskCandidates,
      behaviorChangeCandidates,
      transactionRiskCandidates,
    });

    const enqueueResult = await repository.enqueueJob({
      companyId: credential.companyId,
      credentialId: credential.id,
      requiredScope: REQUIRED_SCOPE,
      eventType: "KPI_DAILY_SUMMARY",
      channel: "whatsapp",
      recipientUserId: owner.userId,
      recipientReference: ownerPhone,
      payload: { text: content.text, ...content.structured },
      idempotencyKey: kpiDailySummaryIdempotencyKey(credential.companyId, businessDate),
    });

    return NextResponse.json({
      business_date: businessDate,
      salesmen_included: lines.length,
      churn_candidates_included: churnCandidates.length,
      unremitted_candidates_included: unremittedCandidates.length,
      call_timing_candidates_included: callTimingCandidates.length,
      discount_anomaly_candidates_included: discountAnomalyCandidates.length,
      collection_risk_candidates_included: collectionRiskCandidates.length,
      behavior_change_candidates_included: behaviorChangeCandidates.length,
      transaction_risk_candidates_included: transactionRiskCandidates.length,
      outcome: enqueueResult.outcome,
      job_id: "jobId" in enqueueResult ? enqueueResult.jobId : null,
    });
  } catch (err) {
    console.error("[Internal Automation /kpi-daily-summary]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
