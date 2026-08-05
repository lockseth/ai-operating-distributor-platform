import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "./repository";

describe("Local demo — Configurable KPI Foundation Waluyo", () => {
  it("owner menyiapkan CALL+EC, membuat target versioned, lalu mengunci periode", async () => {
    const repository = new InMemorySalesKpiRepository();
    repository.seedActor("owner-waluyo", "waluyo", "owner");
    repository.seedSalesperson("salesman-1", "waluyo");

    const initialized = await repository.initializeFoundation({
      companyId: "waluyo",
      actorId: "owner-waluyo",
    });
    expect(initialized).toEqual({ outcome: "initialized", definitionCount: 4 });

    const createdPeriod = await repository.createPeriod({
      companyId: "waluyo",
      actorId: "owner-waluyo",
      name: "Agustus 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      workingDays: 21,
    });
    expect(createdPeriod.outcome).toBe("created");
    if (createdPeriod.outcome !== "created") return;

    await expect(
      repository.setTarget({
        companyId: "waluyo",
        actorId: "owner-waluyo",
        periodId: createdPeriod.periodId,
        salespersonId: "salesman-1",
        kpiCode: "CALL",
        targetValue: 80,
        changeReason: "Target awal Agustus",
      }),
    ).resolves.toMatchObject({ outcome: "created", version: 1 });

    await expect(
      repository.setTarget({
        companyId: "waluyo",
        actorId: "owner-waluyo",
        periodId: createdPeriod.periodId,
        salespersonId: "salesman-1",
        kpiCode: "EFFECTIVE_CALL",
        targetValue: 48,
        changeReason: "Target awal Agustus",
      }),
    ).resolves.toMatchObject({ outcome: "created", version: 1 });

    await expect(
      repository.setTarget({
        companyId: "waluyo",
        actorId: "owner-waluyo",
        periodId: createdPeriod.periodId,
        salespersonId: "salesman-1",
        kpiCode: "EFFECTIVE_CALL",
        targetValue: 50,
        changeReason: "Koreksi target berdasarkan hari efektif",
      }),
    ).resolves.toMatchObject({ outcome: "updated", version: 2 });

    await expect(
      repository.setPeriodStatus({
        companyId: "waluyo",
        actorId: "owner-waluyo",
        periodId: createdPeriod.periodId,
        nextStatus: "ACTIVE",
      }),
    ).resolves.toEqual({ outcome: "updated", status: "ACTIVE" });

    await expect(
      repository.setPeriodStatus({
        companyId: "waluyo",
        actorId: "owner-waluyo",
        periodId: createdPeriod.periodId,
        nextStatus: "LOCKED",
      }),
    ).resolves.toEqual({ outcome: "updated", status: "LOCKED" });

    const definitions = repository.getDefinitions("waluyo");
    const targets = repository.getTargets("waluyo", "salesman-1");
    expect(definitions.map((definition) => definition.code)).toEqual([
      "CALL",
      "EFFECTIVE_CALL",
      "ORDER_COUNT",
      "REVENUE",
    ]);
    expect(targets).toHaveLength(3);
    expect(targets.filter((target) => target.status === "ACTIVE")).toHaveLength(
      2,
    );
    expect(
      JSON.stringify({ definitions, targets }).toLowerCase(),
    ).not.toContain("ar_collection");
  });
});
