import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryDispatchRepository } from "./repository";
import {
  runDispatchPlanning,
  overrideDispatchPlan,
  assignSalesman,
  acceptDispatchPlan,
  computeHasHumanReview,
} from "./workflow";
import type { PlanningInput } from "./types";

// =============================================================================
// AI Dispatch Planner — Human Review & Operational Control Gate: behavioral
// tests (bukan structural/source-text) untuk mutation/domain logic, sesuai
// instruksi eksplisit gate ini. Structural test (terminologi UI, signature
// actions.ts) tetap ada sebagai pelengkap di ui-wiring.test.ts.
// =============================================================================

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const SALESMAN_A1 = "salesman-a1";
const SALESMAN_A2 = "salesman-a2";
const SALESMAN_B1 = "salesman-b1"; // milik company B — tidak boleh valid untuk company A
const OWNER_A = "owner-a"; // user company A tapi BUKAN role sales — tidak boleh valid sebagai Salesman

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
    defaultActorStrategy: "unassigned",
    orderSalespersonId: null,
    ...overrides,
  };
}

describe("Human Review & Operational Control", () => {
  let repo: InMemoryDispatchRepository;

  beforeEach(() => {
    repo = new InMemoryDispatchRepository();
    repo.seedSalesmen(COMPANY_A, [
      { id: SALESMAN_A1, fullName: "Budi (Sales)" },
      { id: SALESMAN_A2, fullName: "Sari (Sales)" },
    ]);
    repo.seedSalesmen(COMPANY_B, [{ id: SALESMAN_B1, fullName: "Toni (Sales B)" }]);
  });

  async function seedScheduledPlan(): Promise<string> {
    repo.seedPlanningInput("order-1", baseInput());
    const result = await runDispatchPlanning(COMPANY_A, "order-1", "creator-1", "2026-07-20", { repository: repo });
    if (result.outcome !== "planned") throw new Error("unreachable");
    expect(result.plan.planningStatus).toBe("scheduled");
    return result.plan.id;
  }

  it("1+2. actor identity dan company selalu dari parameter server (bukan dari payload override) — tercermin di event", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "server-derived-actor", undefined, { repository: repo });

    const event = repo.events.find((e) => e.eventType === "human_override");
    expect(event?.actorId).toBe("server-derived-actor");
    expect(event?.companyId).toBe(COMPANY_A);
  });

  it("3. Plan lintas tenant ditolak (assignSalesman, overrideDispatchPlan, acceptDispatchPlan)", async () => {
    const planId = await seedScheduledPlan();

    const assign = await assignSalesman(COMPANY_B, planId, SALESMAN_B1, "intruder", undefined, { repository: repo });
    expect(assign.outcome).toBe("plan_not_found");

    const override = await overrideDispatchPlan(COMPANY_B, planId, { action: "hold", reason: "mencoba", actorId: "intruder" }, { repository: repo });
    expect(override.outcome).toBe("plan_not_found");

    const accept = await acceptDispatchPlan(COMPANY_B, planId, "intruder", { repository: repo });
    expect(accept.outcome).toBe("plan_not_found");

    // Plan company A tidak berubah sama sekali akibat percobaan lintas tenant.
    const untouched = await repo.getPlan(COMPANY_A, planId);
    expect(untouched?.assignedActorId).toBeNull();
    expect(untouched?.isOverride).toBe(false);
  });

  it("4. Salesman lintas tenant ditolak", async () => {
    const planId = await seedScheduledPlan();
    const result = await assignSalesman(COMPANY_A, planId, SALESMAN_B1, "owner-a", undefined, { repository: repo });
    expect(result.outcome).toBe("invalid_actor");

    const plan = await repo.getPlan(COMPANY_A, planId);
    expect(plan?.assignedActorId).toBeNull(); // tidak ada perubahan
  });

  it("5. User non-Salesman (role lain, sama tenant) ditolak sebagai target assignment", async () => {
    const planId = await seedScheduledPlan();
    // OWNER_A ada di company A tapi TIDAK terdaftar di seedSalesmen (bukan role sales).
    const result = await assignSalesman(COMPANY_A, planId, OWNER_A, "owner-a", undefined, { repository: repo });
    expect(result.outcome).toBe("invalid_actor");
  });

  it("6a. Alasan whitespace-only ditolak untuk overrideDispatchPlan", async () => {
    const planId = await seedScheduledPlan();
    const result = await overrideDispatchPlan(COMPANY_A, planId, { action: "hold", reason: "   ", actorId: "owner-a" }, { repository: repo });
    expect(result.outcome).toBe("invalid_input");
  });

  it("6b. Alasan kosong ditolak untuk reassignment Salesman yang sudah ada (bukan penugasan pertama)", async () => {
    const planId = await seedScheduledPlan();
    const first = await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo });
    expect(first.outcome).toBe("assigned"); // penugasan pertama: alasan tidak wajib

    const secondNoReason = await assignSalesman(COMPANY_A, planId, SALESMAN_A2, "owner-a", "   ", { repository: repo });
    expect(secondNoReason.outcome).toBe("invalid_input");

    const secondWithReason = await assignSalesman(COMPANY_A, planId, SALESMAN_A2, "owner-a", "Budi cuti mendadak.", { repository: repo });
    expect(secondWithReason.outcome).toBe("assigned");
  });

  it("7. Assignment yang sama bersifat idempotent — tidak menulis event baru", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo });
    const eventCountAfterFirst = repo.events.length;

    const repeat = await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo });
    expect(repeat.outcome).toBe("no_op");
    expect(repo.events.length).toBe(eventCountAfterFirst); // tidak ada event tambahan
  });

  it("8. Manual override/reassignment menghasilkan audit event dengan actor+reason+perubahan", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", "Toko dekat rumah Budi.", { repository: repo });

    const event = repo.events.find((e) => e.eventType === "human_override");
    expect(event).toBeDefined();
    expect(event?.isAiDecision).toBe(false);
    expect(event?.actorId).toBe("owner-a");
    expect(event?.reason).toBe("Toko dekat rumah Budi.");
    expect(event?.payload).toMatchObject({ action: "reassign_actor" });
  });

  it("9. Event AI lama tidak hilang setelah human override", async () => {
    const planId = await seedScheduledPlan();
    const aiEventsBefore = repo.events.filter((e) => e.isAiDecision).length;
    expect(aiEventsBefore).toBeGreaterThan(0);

    await overrideDispatchPlan(COMPANY_A, planId, { action: "hold", reason: "Ditunda toko.", actorId: "owner-a" }, { repository: repo });

    const aiEventsAfter = repo.events.filter((e) => e.isAiDecision).length;
    expect(aiEventsAfter).toBe(aiEventsBefore); // event AI lama tetap ada, tidak dihapus/ditimpa
    expect(repo.events.some((e) => e.eventType === "ai_decision")).toBe(true);
  });

  it("10. Planning ulang (runDispatchPlanning) TIDAK menimpa manual override", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo });
    const afterAssign = await repo.getPlan(COMPANY_A, planId);
    expect(afterAssign?.assignedActorId).toBe(SALESMAN_A1);
    expect(afterAssign?.isOverride).toBe(true);

    // Retry run planning pada order yang sama — harus no-op (alreadyProcessed).
    const replanned = await runDispatchPlanning(COMPANY_A, "order-1", "creator-1", "2026-07-20", { repository: repo });
    expect(replanned.outcome).toBe("planned");
    if (replanned.outcome !== "planned") throw new Error("unreachable");
    expect(replanned.alreadyProcessed).toBe(true);
    expect(replanned.plan.assignedActorId).toBe(SALESMAN_A1); // override tetap dipertahankan
    expect(replanned.plan.isOverride).toBe(true);
  });

  it("Accept 1: klik pertama mencatat TEPAT SATU event human_reviewed, tidak mengubah field lain, AI event lama utuh", async () => {
    const planId = await seedScheduledPlan();
    const before = await repo.getPlan(COMPANY_A, planId);
    const aiEventsBefore = repo.events.filter((e) => e.isAiDecision).length;

    const accepted = await acceptDispatchPlan(COMPANY_A, planId, "owner-a", { repository: repo });
    expect(accepted.outcome).toBe("accepted");

    const after = await repo.getPlan(COMPANY_A, planId);
    expect(after?.planningStatus).toBe(before?.planningStatus);
    expect(after?.assignedActorId).toBe(before?.assignedActorId);
    expect(after?.isOverride).toBe(before?.isOverride); // accept tidak mengubah is_override

    const reviewEvents = repo.events.filter((e) => e.eventType === "human_reviewed");
    expect(reviewEvents).toHaveLength(1); // tepat satu
    expect(reviewEvents[0].isAiDecision).toBe(false);
    expect(reviewEvents[0].actorId).toBe("owner-a"); // actor dari parameter server, bukan payload

    const aiEventsAfter = repo.events.filter((e) => e.isAiDecision).length;
    expect(aiEventsAfter).toBe(aiEventsBefore); // event AI lama tidak hilang
  });

  it("Accept 2: klik kedua idempotent — tidak menambah event human_reviewed kedua, tidak mengubah status/assignment", async () => {
    const planId = await seedScheduledPlan();
    await acceptDispatchPlan(COMPANY_A, planId, "owner-a", { repository: repo });
    const eventCountAfterFirst = repo.events.length;
    const stateAfterFirst = await repo.getPlan(COMPANY_A, planId);

    const second = await acceptDispatchPlan(COMPANY_A, planId, "owner-a", { repository: repo });
    expect(second.outcome).toBe("already_reviewed");
    expect(repo.events.length).toBe(eventCountAfterFirst); // tidak ada event baru sama sekali
    expect(repo.events.filter((e) => e.eventType === "human_reviewed")).toHaveLength(1); // tetap satu

    const stateAfterSecond = await repo.getPlan(COMPANY_A, planId);
    expect(stateAfterSecond).toEqual(stateAfterFirst); // status/assignment tidak berubah
  });

  it("Accept 3: computeHasHumanReview mendeteksi plan yang sudah diterima (bukan hanya dari is_override)", async () => {
    const planId = await seedScheduledPlan();
    const planBefore = await repo.getPlan(COMPANY_A, planId);
    expect(computeHasHumanReview(planBefore!, repo.events)).toBe(false); // belum direview

    await acceptDispatchPlan(COMPANY_A, planId, "owner-a", { repository: repo });

    const planAfter = await repo.getPlan(COMPANY_A, planId);
    expect(planAfter!.isOverride).toBe(false); // accept TIDAK mengubah is_override
    // tapi hasHumanReview harus TRUE karena event human_reviewed ada -- inilah
    // kontrak yang wajib dipakai UI, bukan is_override mentah.
    const planEvents = repo.events.filter((e) => e.dispatchPlanId === planId);
    expect(computeHasHumanReview(planAfter!, planEvents)).toBe(true);
  });

  it("Accept 4: plan yang sudah is_override=true TIDAK dapat diterima ulang sebagai rekomendasi AI (tidak menyesatkan)", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo }); // is_override jadi true

    const accepted = await acceptDispatchPlan(COMPANY_A, planId, "owner-a", { repository: repo });
    expect(accepted.outcome).toBe("not_acceptable");
    // Tidak ada event human_reviewed yang menyesatkan tercatat untuk plan yang sudah diubah manusia.
    expect(repo.events.some((e) => e.dispatchPlanId === planId && e.eventType === "human_reviewed")).toBe(false);
  });

  it("Accept 5: lintas tenant ditolak (fail-closed)", async () => {
    const planId = await seedScheduledPlan();
    const result = await acceptDispatchPlan(COMPANY_B, planId, "intruder", { repository: repo });
    expect(result.outcome).toBe("plan_not_found");
    expect(repo.events.some((e) => e.dispatchPlanId === planId && e.eventType === "human_reviewed")).toBe(false);
  });

  it("Accept ditolak untuk plan dalam status conflict (waiting_stock)", async () => {
    repo.seedPlanningInput(
      "order-2",
      baseInput({ salesOrderId: "order-2", lineItems: [{ productId: "prod-1", quantity: 50, weightKgPerUnit: 5 }], systemStockByProduct: { "prod-1": 10 } })
    );
    const planned = await runDispatchPlanning(COMPANY_A, "order-2", "creator-1", "2026-07-20", { repository: repo });
    if (planned.outcome !== "planned") throw new Error("unreachable");
    expect(planned.plan.planningStatus).toBe("waiting_stock");

    const accepted = await acceptDispatchPlan(COMPANY_A, planned.plan.id, "owner-a", { repository: repo });
    expect(accepted.outcome).toBe("not_acceptable");
  });

  it("Unassign (assignedActorId null) selalu valid tanpa cek Salesman", async () => {
    const planId = await seedScheduledPlan();
    await assignSalesman(COMPANY_A, planId, SALESMAN_A1, "owner-a", undefined, { repository: repo });

    const result = await overrideDispatchPlan(
      COMPANY_A,
      planId,
      { action: "reassign_actor", assignedActorId: null, reason: "Batalkan penugasan.", actorId: "owner-a" },
      { repository: repo }
    );
    expect(result.outcome).toBe("overridden");
    if (result.outcome !== "overridden") throw new Error("unreachable");
    expect(result.plan.assignedActorId).toBeNull();
  });
});
