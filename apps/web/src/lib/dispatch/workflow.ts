// =============================================================================
// AI Dispatch Planner — orchestration (repository + service, testable tanpa
// Next.js runtime). "use server" actions (actions.ts) adalah wrapper tipis
// di atas modul ini, pola sama seperti lib/delivery/workflow.ts.
// =============================================================================

import { computeGroupKey, planDispatch } from "./service";
import type { DispatchPlan, DispatchPlanEvent, OverrideInput, PlanningDecision } from "./types";
import type { DispatchRepositoryInterface } from "./repository";

export interface DispatchWorkflowDeps {
  repository: DispatchRepositoryInterface;
}

export type RunDispatchPlanningResult =
  | { outcome: "planned"; plan: DispatchPlan; alreadyProcessed: false }
  | { outcome: "planned"; plan: DispatchPlan; alreadyProcessed: true }
  | { outcome: "order_not_found" };

/**
 * Membuat (atau menemukan, idempotent) dispatch plan untuk sebuah confirmed
 * sales order, lalu menjalankan evaluasi AI Dispatch Planner sekali. Retry
 * pada plan yang SUDAH diproses (bukan document_ready) adalah no-op —
 * mencegah override/keputusan manusia sebelumnya tertimpa oleh retry.
 */
export async function runDispatchPlanning(
  companyId: string,
  salesOrderId: string,
  createdBy: string | null,
  candidateDeliveryDate: string,
  deps: DispatchWorkflowDeps
): Promise<RunDispatchPlanningResult> {
  const plan = await deps.repository.createPlan({ companyId, salesOrderId, createdBy });

  if (plan.planningStatus !== "document_ready") {
    return { outcome: "planned", plan, alreadyProcessed: true };
  }

  await deps.repository.insertEvent({
    companyId,
    dispatchPlanId: plan.id,
    eventType: "planning_started",
    fromStatus: "document_ready",
    toStatus: "waiting_planning",
    actorId: createdBy,
    isAiDecision: true,
    reason: null,
    payload: {},
  });

  const input = await deps.repository.getPlanningInput(companyId, salesOrderId, candidateDeliveryDate, plan.id);
  if (!input) return { outcome: "order_not_found" };

  const decision = planDispatch(input);
  const updated = await deps.repository.applyPlanningDecision(plan.id, decision, false);

  await deps.repository.insertEvent({
    companyId,
    dispatchPlanId: plan.id,
    eventType: "ai_decision",
    fromStatus: "waiting_planning",
    toStatus: decision.planningStatus,
    actorId: null,
    isAiDecision: true,
    reason: decision.planningReason,
    payload: { confidenceScore: decision.confidenceScore },
  });

  return { outcome: "planned", plan: updated, alreadyProcessed: false };
}

export type OverrideDispatchPlanResult =
  | { outcome: "overridden"; plan: DispatchPlan }
  | { outcome: "plan_not_found" }
  | { outcome: "invalid_input"; error: string }
  | { outcome: "invalid_actor"; error: string };

/**
 * Human override — satu-satunya jalur untuk reschedule/regroup/reassign
 * actor/hold/force dispatch. Wajib alasan (non-empty), selalu diaudit
 * (dispatch_plan_events) dan menjadi Knowledge Candidate (belum otomatis
 * dipelajari — menunggu review manusia, pola sama seperti knowledge
 * candidates lain di AODP).
 *
 * reassign_actor WAJIB verifikasi ulang server-side bahwa target benar
 * Salesman aktif di company yang sama (Human Review & Operational Control
 * Gate) -- caller tidak bisa menugaskan user lintas tenant atau user tanpa
 * role sales hanya dengan mengirim UUID.
 */
export async function overrideDispatchPlan(
  companyId: string,
  planId: string,
  override: OverrideInput,
  deps: DispatchWorkflowDeps
): Promise<OverrideDispatchPlanResult> {
  if (!override.reason || override.reason.trim().length === 0) {
    return { outcome: "invalid_input", error: "Alasan override wajib diisi." };
  }

  const plan = await deps.repository.getPlan(companyId, planId);
  if (!plan) return { outcome: "plan_not_found" };

  if (override.action === "reassign_actor" && override.assignedActorId) {
    const isValidSalesman = await deps.repository.isSalesmanInCompany(companyId, override.assignedActorId);
    if (!isValidSalesman) {
      return { outcome: "invalid_actor", error: "Salesman tidak ditemukan atau tidak aktif di perusahaan ini." };
    }
  }

  const previousDecision: PlanningDecision = {
    planningStatus: plan.planningStatus,
    deliveryDate: plan.deliveryDate,
    deliveryArea: plan.deliveryArea,
    deliveryGroupKey: plan.deliveryGroupKey,
    assignedActorId: plan.assignedActorId,
    planningReason: plan.planningReason,
    confidenceScore: plan.confidenceScore,
  };

  const deliveryDate = override.deliveryDate ?? plan.deliveryDate;
  const deliveryArea = override.deliveryArea ?? plan.deliveryArea;
  const assignedActorId = override.action === "reassign_actor" ? (override.assignedActorId ?? null) : plan.assignedActorId;

  const decision: PlanningDecision =
    override.action === "hold"
      ? {
          planningStatus: "manual_hold",
          deliveryDate: plan.deliveryDate,
          deliveryArea: plan.deliveryArea,
          deliveryGroupKey: plan.deliveryGroupKey,
          assignedActorId: plan.assignedActorId,
          planningReason: override.reason,
          confidenceScore: 1,
        }
      : {
          planningStatus: "scheduled",
          deliveryDate,
          deliveryArea,
          deliveryGroupKey: deliveryDate ? computeGroupKey(deliveryArea, deliveryDate) : plan.deliveryGroupKey,
          assignedActorId,
          planningReason: override.reason,
          confidenceScore: 1,
        };

  const updated = await deps.repository.applyPlanningDecision(planId, decision, true);

  await deps.repository.insertEvent({
    companyId,
    dispatchPlanId: planId,
    eventType: "human_override",
    fromStatus: plan.planningStatus,
    toStatus: decision.planningStatus,
    actorId: override.actorId,
    isAiDecision: false,
    reason: override.reason,
    payload: { action: override.action },
  });

  await deps.repository.insertKnowledgeCandidate({
    companyId,
    dispatchPlanId: planId,
    salesOrderId: plan.salesOrderId,
    action: override.action,
    reason: override.reason,
    submittedBy: override.actorId,
    previousDecision,
    newDecision: {
      deliveryDate: decision.deliveryDate ?? undefined,
      deliveryArea: decision.deliveryArea ?? undefined,
      assignedActorId: decision.assignedActorId,
    },
  });

  return { outcome: "overridden", plan: updated };
}

export type AssignSalesmanResult =
  | { outcome: "assigned"; plan: DispatchPlan }
  | { outcome: "no_op"; plan: DispatchPlan } // idempotent -- assignment sama, tidak ada perubahan
  | { outcome: "plan_not_found" }
  | { outcome: "invalid_input"; error: string }
  | { outcome: "invalid_actor"; error: string };

/**
 * Tetapkan/ganti Salesman -- satu-satunya jalur (dipanggil dari
 * assignSalesmanAction). Idempotent (assignment sama = no-op, tidak menulis
 * event baru). Alasan HANYA wajib saat mengganti assignment yang SUDAH ada
 * (bukan penugasan pertama) -- label default dipakai untuk penugasan
 * pertama tanpa alasan tertulis, bukan alasan karangan atas nama user.
 * Delegasi penuh ke overrideDispatchPlan() (reassign_actor) untuk validasi
 * tenant/role Salesman + audit event + knowledge candidate.
 */
export async function assignSalesman(
  companyId: string,
  planId: string,
  salesmanId: string,
  actorId: string,
  reason: string | undefined,
  deps: DispatchWorkflowDeps
): Promise<AssignSalesmanResult> {
  const plan = await deps.repository.getPlan(companyId, planId);
  if (!plan) return { outcome: "plan_not_found" };

  if (plan.assignedActorId === salesmanId) {
    return { outcome: "no_op", plan };
  }

  const isReplacement = plan.assignedActorId !== null;
  const trimmedReason = reason?.trim() ?? "";
  if (isReplacement && trimmedReason.length === 0) {
    return { outcome: "invalid_input", error: "Alasan wajib diisi saat mengganti Salesman yang sudah ditugaskan." };
  }
  const effectiveReason = trimmedReason.length > 0 ? trimmedReason : "Penugasan awal Salesman untuk dispatch plan ini.";

  const result = await overrideDispatchPlan(
    companyId,
    planId,
    { action: "reassign_actor", assignedActorId: salesmanId, reason: effectiveReason, actorId },
    deps
  );

  if (result.outcome === "plan_not_found") return { outcome: "plan_not_found" };
  if (result.outcome === "invalid_input") return { outcome: "invalid_input", error: result.error };
  if (result.outcome === "invalid_actor") return { outcome: "invalid_actor", error: result.error };
  return { outcome: "assigned", plan: result.plan };
}

export type AcceptDispatchPlanResult =
  | { outcome: "accepted"; plan: DispatchPlan }
  | { outcome: "already_reviewed"; plan: DispatchPlan } // idempotent no-op -- event human_reviewed sudah ada
  | { outcome: "plan_not_found" }
  | { outcome: "not_acceptable"; error: string };

const ACCEPTABLE_FOR_REVIEW: readonly DispatchPlan["planningStatus"][] = ["planned", "scheduled", "ready_for_delivery"];

export const HUMAN_REVIEWED_EVENT_TYPE = "human_reviewed";

/**
 * "Sudah direview manusia" TIDAK boleh dibaca hanya dari is_override --
 * accept ("Terima Rekomendasi AI") sengaja TIDAK mengubah is_override
 * (accept bukan perubahan, murni konfirmasi). Kontrak yang benar: sudah
 * direview bila is_override true (pernah diubah/override) ATAU ada event
 * human_reviewed yang sah (pernah diterima apa adanya). Dipakai UI (badge,
 * visibilitas tombol Accept) dan alasan not_acceptable di bawah -- satu
 * sumber kebenaran, tidak diduplikasi logikanya di halaman.
 */
export function computeHasHumanReview(
  plan: Pick<DispatchPlan, "isOverride">,
  events: Pick<DispatchPlanEvent, "eventType">[]
): boolean {
  return plan.isOverride || events.some((e) => e.eventType === HUMAN_REVIEWED_EVENT_TYPE);
}

/**
 * "Terima Rekomendasi AI" -- TIDAK ada kolom "reviewed"/"accepted" di skema
 * dispatch_plans (tidak diasumsikan, tidak ditambah migration). Kontrak yang
 * SUDAH mendukung ini: dispatch_plan_events.event_type adalah TEXT bebas
 * (bukan enum) -- "human_reviewed" adalah event baru yang murni tambahan
 * data (bukan skema baru), tidak mengubah planning_status atau field
 * dispatch_plans mana pun. AI decision sebelumnya (event ai_decision) TETAP
 * ada, append-only.
 *
 * Idempotent (hasEventOfType dicek sebelum insert -- klik kedua tidak
 * menambah event kedua) dan menolak plan yang SUDAH is_override=true
 * (sudah diubah/direview manusia -- tidak boleh "diterima sebagai
 * rekomendasi AI" lagi, itu akan menyesatkan riwayat).
 */
export async function acceptDispatchPlan(
  companyId: string,
  planId: string,
  actorId: string,
  deps: DispatchWorkflowDeps
): Promise<AcceptDispatchPlanResult> {
  const plan = await deps.repository.getPlan(companyId, planId);
  if (!plan) return { outcome: "plan_not_found" };

  if (plan.isOverride) {
    return {
      outcome: "not_acceptable",
      error: "Plan ini sudah direview/diubah manusia sebelumnya, tidak dapat diterima ulang sebagai rekomendasi AI.",
    };
  }

  if (!ACCEPTABLE_FOR_REVIEW.includes(plan.planningStatus)) {
    return {
      outcome: "not_acceptable",
      error: "Plan ini memerlukan penanganan/override, bukan sekadar diterima (masih dalam status conflict).",
    };
  }

  const alreadyReviewed = await deps.repository.hasEventOfType(companyId, planId, HUMAN_REVIEWED_EVENT_TYPE);
  if (alreadyReviewed) {
    return { outcome: "already_reviewed", plan };
  }

  await deps.repository.insertEvent({
    companyId,
    dispatchPlanId: planId,
    eventType: HUMAN_REVIEWED_EVENT_TYPE,
    fromStatus: plan.planningStatus,
    toStatus: plan.planningStatus, // tidak berubah -- accept tidak memutasi keputusan AI, hanya mencatat review
    actorId,
    isAiDecision: false,
    reason: null,
    payload: {},
  });

  return { outcome: "accepted", plan };
}

export type MarkReadyResult = { outcome: "ready"; plan: DispatchPlan } | { outcome: "not_scheduled" } | { outcome: "not_found" };

export async function markPlanReadyForDelivery(
  companyId: string,
  planId: string,
  actorId: string,
  deps: DispatchWorkflowDeps
): Promise<MarkReadyResult> {
  const plan = await deps.repository.getPlan(companyId, planId);
  if (!plan) return { outcome: "not_found" };
  if (plan.planningStatus !== "scheduled") return { outcome: "not_scheduled" };

  const updated = await deps.repository.markReadyForDelivery(companyId, planId, actorId);
  await deps.repository.insertEvent({
    companyId,
    dispatchPlanId: planId,
    eventType: "ready_for_delivery",
    fromStatus: "scheduled",
    toStatus: "ready_for_delivery",
    actorId,
    isAiDecision: false,
    reason: null,
    payload: {},
  });
  return { outcome: "ready", plan: updated };
}
