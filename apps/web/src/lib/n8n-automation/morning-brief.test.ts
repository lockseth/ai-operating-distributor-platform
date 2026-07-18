import { describe, expect, it } from "vitest";
import { buildMorningBrief, composeMorningBriefForSalesman, morningBriefIdempotencyKey } from "./morning-brief";
import { InMemorySalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";

const ACTIVE_PERIOD = {
  id: "period-1",
  name: "Agustus 2026",
  startDate: "2026-08-01",
  endDate: "2026-08-31",
};

function projectionWithTargets(): SalesKpiAchievementProjection {
  return {
    companyId: "waluyo",
    salespersonId: "sales-1",
    periodId: "period-1",
    periodName: "Agustus 2026",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    call: { kpiCode: "CALL", target: 10, actual: 4, remaining: 6, achievementPercentage: 40, pacingStatus: "ON_TRACK" },
    effectiveCall: { kpiCode: "EFFECTIVE_CALL", target: 5, actual: 2, remaining: 3, achievementPercentage: 40, pacingStatus: "ON_TRACK" },
    sourceFreshness: "COMPLETE",
  };
}

describe("buildMorningBrief -- n8n tidak menghitung Call/EC/EC Rate sendiri", () => {
  it("tidak ada periode ACTIVE -> pesan eksplisit, TIDAK mengarang target 0", () => {
    const content = buildMorningBrief({
      tenantName: "Waluyo Distributor",
      salesmanFullName: "Budi",
      coverageAreas: ["Utara"],
      businessDate: "2026-08-10",
      activePeriod: null,
      projection: null,
      baseline: null,
    });
    expect(content.text).toContain("belum diaktifkan");
    expect(content.text).toContain("bukan berarti target 0"); // disclaimer eksplisit, bukan angka 0 seolah resmi
    expect(content.text).not.toMatch(/Call:\s*\d+\/0|EC:\s*\d+\/0/i); // tidak ada "Call: x/0" yang seolah target resmi
    expect(content.structured.status).toBe("NO_ACTIVE_PERIOD");
    expect(content.structured.activePeriod).toBeNull();
  });

  it("periode ACTIVE dengan target -> angka SAMA PERSIS dengan input projection (bukan dihitung ulang)", () => {
    const projection = projectionWithTargets();
    const content = buildMorningBrief({
      tenantName: "Waluyo Distributor",
      salesmanFullName: "Budi",
      coverageAreas: ["Utara", "Selatan"],
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      projection,
      baseline: null,
    });

    expect(content.text).toContain("Budi");
    expect(content.text).toContain("Waluyo Distributor");
    expect(content.text).toContain("Utara, Selatan");
    expect(content.text).toContain("4/10"); // actual/target Call, langsung dari projection
    expect(content.text).toContain("2/5"); // actual/target EC
    expect(content.text).toContain("50%"); // EC Rate = round(2/4*100) = 50, dihitung presenter dari actual saja (bukan dari service lain)
    expect(content.structured.call).toEqual(projection.call);
    expect(content.structured.effectiveCall).toEqual(projection.effectiveCall);
  });

  it("target belum ditetapkan (target null) -> 'Data belum cukup', bukan 0", () => {
    const projection: SalesKpiAchievementProjection = {
      ...projectionWithTargets(),
      call: { kpiCode: "CALL", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
      effectiveCall: { kpiCode: "EFFECTIVE_CALL", target: null, actual: 0, remaining: null, achievementPercentage: null, pacingStatus: "DATA_INSUFFICIENT" },
    };
    const content = buildMorningBrief({
      tenantName: "Waluyo Distributor",
      salesmanFullName: "Budi",
      coverageAreas: [],
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      projection,
      baseline: null,
    });
    expect(content.text).toContain("Data belum cukup");
  });

  it("coverage area kosong -> tampil '-' bukan string kosong", () => {
    const content = buildMorningBrief({
      tenantName: "Waluyo Distributor",
      salesmanFullName: "Budi",
      coverageAreas: [],
      businessDate: "2026-08-10",
      activePeriod: null,
      projection: null,
      baseline: null,
    });
    expect(content.text).toContain("Wilayah: -");
  });

  it("baseline INSUFFICIENT -> catatan sufficiency muncul di teks", () => {
    const projection = projectionWithTargets();
    const content = buildMorningBrief({
      tenantName: "Waluyo Distributor",
      salesmanFullName: "Budi",
      coverageAreas: ["Utara"],
      businessDate: "2026-08-10",
      activePeriod: ACTIVE_PERIOD,
      projection,
      baseline: {
        salespersonId: "sales-1",
        windowStartDate: "2026-05-03",
        windowEndDate: "2026-07-31",
        observedDays: 2,
        historicalCall: 2,
        historicalEffectiveCall: 0,
        ecRate: 0,
        sufficiency: "INSUFFICIENT",
      },
    });
    expect(content.text).toContain("baseline historis");
  });
});

describe("composeMorningBriefForSalesman -- dipakai jalur cron proaktif MAUPUN Telegram on-demand (/start)", () => {
  it("tanpa periode ACTIVE -> sama seperti buildMorningBrief langsung (NO_ACTIVE_PERIOD)", async () => {
    const repo = new InMemorySalesKpiRepository();
    repo.seedActor("owner-1", "waluyo", "owner");
    repo.seedSalesperson("sales-1", "waluyo");
    const content = await composeMorningBriefForSalesman(
      { salesKpiRepository: repo },
      "waluyo",
      "owner-1",
      { userId: "sales-1", fullName: "Budi", coverageAreas: ["Utara"] },
      "Waluyo Distributor",
      "2026-08-10",
    );
    expect(content.structured.status).toBe("NO_ACTIVE_PERIOD");
  });

  it("dengan periode ACTIVE dan Call tercatat -> projection actual mengikuti ledger, bukan dikarang ulang", async () => {
    const repo = new InMemorySalesKpiRepository();
    repo.seedActor("owner-1", "waluyo", "owner");
    repo.seedSalesperson("sales-1", "waluyo");
    repo.seedActor("sales-1", "waluyo", "sales" as never);
    repo.seedCustomer("cust-1", "waluyo", { assignedSalesId: "sales-1" });
    await repo.initializeFoundation({ companyId: "waluyo", actorId: "owner-1" });
    const period = await repo.createPeriod({
      companyId: "waluyo",
      actorId: "owner-1",
      name: "Agustus 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      workingDays: 26,
    });
    if (period.outcome !== "created") throw new Error("seed periode gagal");
    await repo.setPeriodStatus({
      companyId: "waluyo",
      actorId: "owner-1",
      periodId: period.periodId,
      nextStatus: "ACTIVE",
    });
    await repo.setTarget({
      companyId: "waluyo",
      actorId: "owner-1",
      periodId: period.periodId,
      salespersonId: "sales-1",
      kpiCode: "CALL",
      targetValue: 10,
      changeReason: "target awal periode",
    });
    await repo.recordCall({
      companyId: "waluyo",
      actorId: "sales-1",
      salespersonId: "sales-1",
      customerId: "cust-1",
      callDate: "2026-08-10",
      outcomeNotes: "Kunjungan pagi",
      idempotencyKey: "call-1",
    });

    const content = await composeMorningBriefForSalesman(
      { salesKpiRepository: repo },
      "waluyo",
      "owner-1",
      { userId: "sales-1", fullName: "Budi", coverageAreas: ["Utara"] },
      "Waluyo Distributor",
      "2026-08-10",
    );
    expect(content.structured.status).toBe("ACTIVE_PERIOD");
    expect(content.text).toContain("1/10");
  });
});

describe("morningBriefIdempotencyKey", () => {
  it("satu salesman + satu business date -> key unik dan stabil", () => {
    expect(morningBriefIdempotencyKey("sales-1", "2026-08-10")).toBe("morning_brief:sales-1:2026-08-10");
    expect(morningBriefIdempotencyKey("sales-1", "2026-08-10")).toBe(morningBriefIdempotencyKey("sales-1", "2026-08-10"));
    expect(morningBriefIdempotencyKey("sales-1", "2026-08-11")).not.toBe(morningBriefIdempotencyKey("sales-1", "2026-08-10"));
  });
});
