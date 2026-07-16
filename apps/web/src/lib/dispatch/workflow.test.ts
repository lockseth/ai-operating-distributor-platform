import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDispatchRepository } from "./repository";
import { runDispatchPlanning, overrideDispatchPlan, markPlanReadyForDelivery } from "./workflow";
import type { PlanningInput } from "./types";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

function baseInput(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return {
    companyId: COMPANY_A,
    salesOrderId: "order-1",
    customerArea: "Kota",
    requestedDeliveryDate: null,
    orderValue: 1_000_000,
    orderMarginValue: 200_000,
    lineItems: [{ productId: "prod-1", quantity: 10, weightKgPerUnit: 5 }],
    systemStockByProduct: { "prod-1": 100 },
    reservedByProduct: {},
    expectedIncomingByProduct: {},
    existingGroupTonnageKg: {},
    candidateDeliveryDate: "2026-07-20",
    maxTonnagePerRouteKg: 1000,
    minOrderValueForSameDay: null,
    defaultActorStrategy: "order_salesperson",
    orderSalespersonId: "sales-1",
    ...overrides,
  };
}

describe("AI Dispatch Planner", () => {
  let repo: InMemoryDispatchRepository;

  beforeEach(() => {
    repo = new InMemoryDispatchRepository();
  });

  it("1. Normal Planning — clean order auto-schedules", async () => {
    repo.seedPlanningInput("order-1", baseInput());
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });

    expect(result.outcome).toBe("planned");
    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("scheduled");
    expect(result.plan.deliveryDate).toBe("2026-07-20");
    expect(result.plan.deliveryGroupKey).toBe("Kota|2026-07-20");
    expect(result.plan.assignedActorId).toBe("sales-1");
    expect(result.plan.isOverride).toBe(false);

    const events = repo.events.filter((e) => e.dispatchPlanId === result.plan.id);
    expect(events.map((e) => e.toStatus)).toEqual(["waiting_planning", "scheduled"]);
  });

  it("2. Customer Delay — honors customer-requested date instead of forcing candidate date", async () => {
    repo.seedPlanningInput("order-1", baseInput({ requestedDeliveryDate: "2026-07-25" }));
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });

    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("customer_requested_delay");
    expect(result.plan.deliveryDate).toBe("2026-07-25");
    expect(result.plan.confidenceScore).toBeGreaterThanOrEqual(0.9);
  });

  it("3. Waiting Stock — insufficient Available To Promise blocks auto-schedule", async () => {
    repo.seedPlanningInput(
      "order-1",
      baseInput({
        lineItems: [{ productId: "prod-1", quantity: 50, weightKgPerUnit: 5 }],
        systemStockByProduct: { "prod-1": 10 },
      })
    );
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });

    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("waiting_stock");
    expect(result.plan.assignedActorId).toBe("sales-1"); // actor tetap diusulkan walau stock conflict
  });

  it("3b. Route Conflict — tonnage exceeds tenant-configured route limit", async () => {
    repo.seedPlanningInput(
      "order-1",
      baseInput({
        lineItems: [{ productId: "prod-1", quantity: 300, weightKgPerUnit: 5 }], // 1500kg
        systemStockByProduct: { "prod-1": 1000 },
        maxTonnagePerRouteKg: 1000,
      })
    );
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });

    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("route_conflict");
  });

  it("4. Manual Override — force_dispatch resolves waiting_stock, is audited and becomes a Knowledge Candidate", async () => {
    repo.seedPlanningInput(
      "order-1",
      baseInput({
        lineItems: [{ productId: "prod-1", quantity: 50, weightKgPerUnit: 5 }],
        systemStockByProduct: { "prod-1": 10 },
      })
    );
    const planned = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (planned.outcome !== "planned") throw new Error("unreachable");
    expect(planned.plan.planningStatus).toBe("waiting_stock");

    const overridden = await overrideDispatchPlan(
      COMPANY_A,
      planned.plan.id,
      { action: "force_dispatch", reason: "Stok fisik gudang mencukupi, sistem belum ter-update.", actorId: "owner-1" },
      { repository: repo }
    );

    expect(overridden.outcome).toBe("overridden");
    if (overridden.outcome !== "overridden") throw new Error("unreachable");
    expect(overridden.plan.planningStatus).toBe("scheduled");
    expect(overridden.plan.isOverride).toBe(true);

    const overrideEvent = repo.events.find((e) => e.eventType === "human_override");
    expect(overrideEvent?.isAiDecision).toBe(false);
    expect(overrideEvent?.reason).toContain("Stok fisik");

    expect(repo.knowledgeCandidates).toHaveLength(1);
    expect(repo.knowledgeCandidates[0].candidateType).toBe("dispatch_planning_override");
  });

  it("4b. Manual Override — hold requires reason and does not silently learn without one", async () => {
    repo.seedPlanningInput("order-1", baseInput());
    const planned = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (planned.outcome !== "planned") throw new Error("unreachable");

    const rejected = await overrideDispatchPlan(
      COMPANY_A,
      planned.plan.id,
      { action: "hold", reason: "", actorId: "owner-1" },
      { repository: repo }
    );
    expect(rejected.outcome).toBe("invalid_input");

    const held = await overrideDispatchPlan(
      COMPANY_A,
      planned.plan.id,
      { action: "hold", reason: "Menunggu konfirmasi customer.", actorId: "owner-1" },
      { repository: repo }
    );
    expect(held.outcome).toBe("overridden");
    if (held.outcome !== "overridden") throw new Error("unreachable");
    expect(held.plan.planningStatus).toBe("manual_hold");
  });

  it("5. Duplicate Retry — second run on an already-processed plan is a no-op", async () => {
    repo.seedPlanningInput("order-1", baseInput());
    const first = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (first.outcome !== "planned") throw new Error("unreachable");
    expect(first.alreadyProcessed).toBe(false);

    const second = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (second.outcome !== "planned") throw new Error("unreachable");
    expect(second.alreadyProcessed).toBe(true);
    expect(second.plan.id).toBe(first.plan.id);

    // Hanya satu plan tersimpan, dan event AI hanya tercatat sekali (bukan digandakan oleh retry).
    expect(repo.plans.size).toBe(1);
    const aiEvents = repo.events.filter((e) => e.dispatchPlanId === first.plan.id && e.isAiDecision);
    expect(aiEvents).toHaveLength(2); // planning_started + ai_decision, sekali saja
  });

  it("6. Tenant Isolation — plan milik company A tidak terlihat dari company B", async () => {
    repo.seedPlanningInput("order-1", baseInput());
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (result.outcome !== "planned") throw new Error("unreachable");

    const crossTenant = await repo.getPlan(COMPANY_B, result.plan.id);
    expect(crossTenant).toBeNull();

    const crossTenantBySalesOrder = await repo.findPlanBySalesOrder(COMPANY_B, "order-1");
    expect(crossTenantBySalesOrder).toBeNull();

    const overrideAcrossTenant = await overrideDispatchPlan(
      COMPANY_B,
      result.plan.id,
      { action: "force_dispatch", reason: "mencoba akses tenant lain", actorId: "intruder" },
      { repository: repo }
    );
    expect(overrideAcrossTenant.outcome).toBe("plan_not_found");
  });

  it("7. Planning Status Transition — document_ready -> waiting_planning -> scheduled -> ready_for_delivery", async () => {
    repo.seedPlanningInput("order-1", baseInput());
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "user-1", "2026-07-20", { repository: repo });
    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("scheduled");

    const ready = await markPlanReadyForDelivery(COMPANY_A, result.plan.id, "owner-1", { repository: repo });
    expect(ready.outcome).toBe("ready");
    if (ready.outcome !== "ready") throw new Error("unreachable");
    expect(ready.plan.planningStatus).toBe("ready_for_delivery");

    // Tidak bisa lompat langsung dari ready_for_delivery ke ready_for_delivery lagi tanpa scheduled.
    const invalid = await markPlanReadyForDelivery(COMPANY_A, result.plan.id, "owner-1", { repository: repo });
    expect(invalid.outcome).toBe("not_scheduled");

    const transitions = repo.events
      .filter((e) => e.dispatchPlanId === result.plan.id)
      .map((e) => `${e.fromStatus}->${e.toStatus}`);
    expect(transitions).toEqual([
      "document_ready->waiting_planning",
      "waiting_planning->scheduled",
      "scheduled->ready_for_delivery",
    ]);
  });
});
