// =============================================================================
// AI Dispatch Planner — orchestration (repository + service, testable tanpa
// Next.js runtime). "use server" actions (actions.ts) adalah wrapper tipis
// di atas modul ini, pola sama seperti lib/delivery/workflow.ts.
// =============================================================================

import { computeGroupKey, planDispatch } from "./service";
import type { DispatchPlan, OverrideInput, PlanningDecision } from "./types";
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
  | { outcome: "invalid_input"; error: string };

/**
 * Human override — satu-satunya jalur untuk reschedule/regroup/reassign
 * actor/hold/force dispatch. Wajib alasan (non-empty), selalu diaudit
 * (dispatch_plan_events) dan menjadi Knowledge Candidate (belum otomatis
 * dipelajari — menunggu review manusia, pola sama seperti knowledge
 * candidates lain di AODP).
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
