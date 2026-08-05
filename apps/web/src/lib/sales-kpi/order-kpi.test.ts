// =============================================================================
// Gate 3E-D0-F3 -- unit test agregasi ORDER_COUNT/REVENUE (InMemory repo).
// Kredit/reversal ORDER_COUNT/REVENUE sesungguhnya hidup sebagai trigger
// Postgres (lihat order-kpi-achievement.integration.test.ts) -- file ini
// HANYA menguji logika agregasi TypeScript (getAchievementProjection) yang
// dipakai bersama oleh /dashboard/kpi, Morning Brief, dan (secara struktural,
// tabel yang sama) Dashboard Owner, lewat baris ledger yang di-seed langsung.
// =============================================================================

import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "./repository";

const COMPANY = "waluyo";
const OWNER = "owner-1";
const SALES_1 = "sales-1";

async function readyRepository(): Promise<InMemorySalesKpiRepository> {
  const repository = new InMemorySalesKpiRepository();
  repository.seedActor(OWNER, COMPANY, "owner");
  repository.seedActor(SALES_1, COMPANY, "sales");
  repository.seedSalesperson(SALES_1, COMPANY);
  await repository.initializeFoundation({ companyId: COMPANY, actorId: OWNER });
  return repository;
}

async function activePeriod(repository: InMemorySalesKpiRepository): Promise<string> {
  const created = await repository.createPeriod({
    companyId: COMPANY, actorId: OWNER, name: "September 2026",
    startDate: "2026-09-01", endDate: "2026-09-30", workingDays: 22,
  });
  if (created.outcome !== "created") throw new Error("period setup failed");
  await repository.setPeriodStatus({
    companyId: COMPANY, actorId: OWNER, periodId: created.periodId, nextStatus: "ACTIVE",
  });
  return created.periodId;
}

describe("Gate 3E-D0-F3 -- ORDER_COUNT/REVENUE target & projection", () => {
  it("Owner dapat menetapkan target ORDER_COUNT dan REVENUE terpisah dari CALL/EC", async () => {
    const repository = await readyRepository();
    const periodId = await activePeriod(repository);

    const orderCountResult = await repository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      kpiCode: "ORDER_COUNT", targetValue: 40, changeReason: "Target awal",
    });
    expect(orderCountResult).toMatchObject({ outcome: "created", version: 1 });

    const revenueResult = await repository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      kpiCode: "REVENUE", targetValue: 60_000_000, changeReason: "Target awal",
    });
    expect(revenueResult).toMatchObject({ outcome: "created", version: 1 });
  });

  it("actual REVENUE = SUM(value) CREDITED - SUM(value) REVERSED (bukan hitung baris)", async () => {
    const repository = await readyRepository();
    const periodId = await activePeriod(repository);
    await repository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      kpiCode: "REVENUE", targetValue: 1_000_000, changeReason: "Target awal",
    });

    repository.seedAchievementEvent(COMPANY, SALES_1, "REVENUE", "CREDITED", "2026-09-05", {
      value: 250_000, orderId: "order-1",
    });
    repository.seedAchievementEvent(COMPANY, SALES_1, "REVENUE", "CREDITED", "2026-09-06", {
      value: 500_000, orderId: "order-2",
    });
    // order-2 dibatalkan -- reversal membawa value yang SAMA
    repository.seedAchievementEvent(COMPANY, SALES_1, "REVENUE", "REVERSED", "2026-09-06", {
      value: 500_000, orderId: "order-2",
    });

    const result = await repository.getAchievementProjection({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.projection.revenue.actual).toBe(250_000);
    expect(result.projection.revenue.target).toBe(1_000_000);
  });

  it("ORDER_COUNT actual menghitung jumlah order confirmed (value=1 per order), independen dari REVENUE", async () => {
    const repository = await readyRepository();
    const periodId = await activePeriod(repository);
    await repository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      kpiCode: "ORDER_COUNT", targetValue: 5, changeReason: "Target awal",
    });

    for (let i = 0; i < 3; i += 1) {
      repository.seedAchievementEvent(COMPANY, SALES_1, "ORDER_COUNT", "CREDITED", "2026-09-10", {
        value: 1, orderId: `order-${i}`,
      });
    }

    const result = await repository.getAchievementProjection({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.projection.orderCount.actual).toBe(3);
    expect(result.projection.orderCount.target).toBe(5);
  });

  it("clean slate (tidak ada target/achievement sama sekali) -> sourceFreshness DATA_INSUFFICIENT, bukan 0/Tercapai yang dikarang", async () => {
    const repository = await readyRepository();
    const periodId = await activePeriod(repository);

    const result = await repository.getAchievementProjection({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.projection.sourceFreshness).toBe("DATA_INSUFFICIENT");
    expect(result.projection.call.target).toBeNull();
    expect(result.projection.effectiveCall.target).toBeNull();
    expect(result.projection.orderCount.target).toBeNull();
    expect(result.projection.revenue.target).toBeNull();
    expect(result.projection.orderCount.pacingStatus).toBe("DATA_INSUFFICIENT");
    expect(result.projection.revenue.pacingStatus).toBe("DATA_INSUFFICIENT");
  });

  it("sourceFreshness COMPLETE jika HANYA REVENUE yang punya target (tidak butuh keempatnya sekaligus)", async () => {
    const repository = await readyRepository();
    const periodId = await activePeriod(repository);
    await repository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      kpiCode: "REVENUE", targetValue: 10_000_000, changeReason: "Target awal",
    });

    const result = await repository.getAchievementProjection({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.projection.sourceFreshness).toBe("COMPLETE");
    expect(result.projection.call.target).toBeNull();
    expect(result.projection.revenue.target).toBe(10_000_000);
  });
});
