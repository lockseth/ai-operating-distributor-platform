import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "./repository";
import {
  WALUYO_SALES_KPI_DEFINITIONS,
  canTransitionSalesKpiPeriod,
  isSalesKpiCode,
  validateSalesKpiPeriodInput,
  validateSalesKpiTargetInput,
} from "./service";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const OWNER_A = "owner-a";
const MANAGER_A = "manager-a";
const SALES_A = "sales-a";
const SALES_B = "sales-b";

function readyRepository(): InMemorySalesKpiRepository {
  const repository = new InMemorySalesKpiRepository();
  repository.seedActor(OWNER_A, COMPANY_A, "owner");
  repository.seedActor(MANAGER_A, COMPANY_A, "manager");
  repository.seedActor(SALES_A, COMPANY_A, "sales");
  repository.seedSalesperson(SALES_A, COMPANY_A);
  repository.seedSalesperson(SALES_B, COMPANY_B);
  return repository;
}

async function createJulyPeriod(
  repository: InMemorySalesKpiRepository,
): Promise<string> {
  const result = await repository.createPeriod({
    companyId: COMPANY_A,
    actorId: OWNER_A,
    name: "Juli 2026",
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    workingDays: 23,
  });
  if (result.outcome !== "created")
    throw new Error(`period setup failed: ${result.outcome}`);
  return result.periodId;
}

describe("Sales KPI definition contract — Waluyo v1", () => {
  it("mengaktifkan tepat dua KPI: CALL dan EFFECTIVE_CALL", () => {
    expect(
      WALUYO_SALES_KPI_DEFINITIONS.map((definition) => definition.code),
    ).toEqual(["CALL", "EFFECTIVE_CALL"]);
  });

  it("tidak memiliki AR, Collection, omzet, weight, atau composite score", () => {
    const serialized = JSON.stringify(
      WALUYO_SALES_KPI_DEFINITIONS,
    ).toLowerCase();
    expect(serialized).not.toMatch(/collection|omzet|revenue|weight|composite/);
    expect(
      WALUYO_SALES_KPI_DEFINITIONS.every(
        (definition) => definition.unit === "COUNT",
      ),
    ).toBe(true);
  });

  it("measurement source EC mengunci confirmed field-visit order", () => {
    const ec = WALUYO_SALES_KPI_DEFINITIONS.find(
      (definition) => definition.code === "EFFECTIVE_CALL",
    );
    expect(ec?.measurementSource).toBe("CONFIRMED_FIELD_VISIT_ORDER");
    expect(ec?.description).toContain("order_source FIELD_VISIT");
  });

  it("runtime code guard fail-closed untuk KPI lain", () => {
    expect(isSalesKpiCode("CALL")).toBe(true);
    expect(isSalesKpiCode("EFFECTIVE_CALL")).toBe(true);
    expect(isSalesKpiCode("AR_COLLECTION")).toBe(false);
    expect(isSalesKpiCode("REVENUE")).toBe(false);
  });
});

describe("Sales KPI input validation", () => {
  it("menolak tanggal semu dan range terbalik", () => {
    expect(
      validateSalesKpiPeriodInput({
        name: "Juli",
        startDate: "2026-02-30",
        endDate: "2026-03-01",
        workingDays: 1,
      }),
    ).toBe("invalid_date_range");
    expect(
      validateSalesKpiPeriodInput({
        name: "Juli",
        startDate: "2026-07-31",
        endDate: "2026-07-01",
        workingDays: 1,
      }),
    ).toBe("invalid_date_range");
  });

  it("menolak working days non-integer, nol, atau melebihi hari kalender", () => {
    expect(
      validateSalesKpiPeriodInput({
        name: "Juli",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        workingDays: 23.5,
      }),
    ).toBe("invalid_working_days");
    expect(
      validateSalesKpiPeriodInput({
        name: "Juli",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        workingDays: 0,
      }),
    ).toBe("invalid_working_days");
    expect(
      validateSalesKpiPeriodInput({
        name: "Juli",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        workingDays: 32,
      }),
    ).toBe("invalid_working_days");
  });

  it("menolak target non-integer/negatif dan alasan perubahan kosong; target 0 sah (non-negatif, sejak 20260806000001)", () => {
    expect(
      validateSalesKpiTargetInput({
        kpiCode: "CALL",
        targetValue: 10.5,
        changeReason: "Target awal",
      }),
    ).toBe("invalid_target");
    expect(
      validateSalesKpiTargetInput({
        kpiCode: "CALL",
        targetValue: -1,
        changeReason: "Target awal",
      }),
    ).toBe("invalid_target");
    expect(
      validateSalesKpiTargetInput({
        kpiCode: "CALL",
        targetValue: 0,
        changeReason: "Target awal",
      }),
    ).toBeNull();
    expect(
      validateSalesKpiTargetInput({
        kpiCode: "CALL",
        targetValue: 10,
        changeReason: " ",
      }),
    ).toBe("reason_required");
  });

  it("status periode hanya bergerak maju", () => {
    expect(canTransitionSalesKpiPeriod("DRAFT", "ACTIVE")).toBe(true);
    expect(canTransitionSalesKpiPeriod("ACTIVE", "LOCKED")).toBe(true);
    expect(canTransitionSalesKpiPeriod("LOCKED", "ACTIVE")).toBe(false);
    expect(canTransitionSalesKpiPeriod("ACTIVE", "DRAFT")).toBe(false);
  });
});

describe("Configurable KPI Foundation repository", () => {
  it("initializer idempotent dan audit hanya dibuat saat insert pertama", async () => {
    const repository = readyRepository();
    await expect(
      repository.initializeFoundation({
        companyId: COMPANY_A,
        actorId: OWNER_A,
      }),
    ).resolves.toEqual({
      outcome: "initialized",
      definitionCount: 2,
    });
    await expect(
      repository.initializeFoundation({
        companyId: COMPANY_A,
        actorId: OWNER_A,
      }),
    ).resolves.toEqual({
      outcome: "already_initialized",
      definitionCount: 2,
    });
    expect(repository.getDefinitions(COMPANY_A)).toHaveLength(2);
    expect(
      repository
        .getAuditTrail(COMPANY_A)
        .filter((event) => event.action === "sales_kpi.foundation_initialized"),
    ).toHaveLength(1);
  });

  it("Salesman dan admin tidak dapat menginisialisasi foundation", async () => {
    const repository = readyRepository();
    repository.seedActor("admin-a", COMPANY_A, "admin");
    await expect(
      repository.initializeFoundation({
        companyId: COMPANY_A,
        actorId: SALES_A,
      }),
    ).resolves.toEqual({ outcome: "forbidden" });
    await expect(
      repository.initializeFoundation({
        companyId: COMPANY_A,
        actorId: "admin-a",
      }),
    ).resolves.toEqual({ outcome: "forbidden" });
  });

  it("actor tenant A tidak dapat mengubah tenant B", async () => {
    const repository = readyRepository();
    await expect(
      repository.initializeFoundation({
        companyId: COMPANY_B,
        actorId: OWNER_A,
      }),
    ).resolves.toEqual({ outcome: "forbidden" });
    expect(repository.getDefinitions(COMPANY_B)).toHaveLength(0);
  });

  it("periode overlap ditolak dalam tenant yang sama tetapi tenant lain tetap independen", async () => {
    const repository = readyRepository();
    await createJulyPeriod(repository);
    await expect(
      repository.createPeriod({
        companyId: COMPANY_A,
        actorId: OWNER_A,
        name: "Overlap Juli",
        startDate: "2026-07-15",
        endDate: "2026-08-14",
        workingDays: 20,
      }),
    ).resolves.toEqual({ outcome: "overlapping_period" });

    repository.seedActor("owner-b", COMPANY_B, "owner");
    await expect(
      repository.createPeriod({
        companyId: COMPANY_B,
        actorId: "owner-b",
        name: "Juli 2026",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        workingDays: 23,
      }),
    ).resolves.toMatchObject({ outcome: "created" });
  });

  it("target tidak dapat dibuat sebelum foundation diinisialisasi", async () => {
    const repository = readyRepository();
    const periodId = await createJulyPeriod(repository);
    await expect(
      repository.setTarget({
        companyId: COMPANY_A,
        actorId: OWNER_A,
        periodId,
        salespersonId: SALES_A,
        kpiCode: "CALL",
        targetValue: 20,
        changeReason: "Target awal",
      }),
    ).resolves.toEqual({ outcome: "foundation_not_initialized" });
  });

  it("target pertama version 1; revisi membuat version 2 dan mempertahankan history", async () => {
    const repository = readyRepository();
    await repository.initializeFoundation({
      companyId: COMPANY_A,
      actorId: OWNER_A,
    });
    const periodId = await createJulyPeriod(repository);

    const first = await repository.setTarget({
      companyId: COMPANY_A,
      actorId: OWNER_A,
      periodId,
      salespersonId: SALES_A,
      kpiCode: "CALL",
      targetValue: 20,
      changeReason: "Target awal Juli",
    });
    expect(first).toMatchObject({ outcome: "created", version: 1 });

    const revised = await repository.setTarget({
      companyId: COMPANY_A,
      actorId: MANAGER_A,
      periodId,
      salespersonId: SALES_A,
      kpiCode: "CALL",
      targetValue: 24,
      changeReason: "Penyesuaian hari kerja",
    });
    expect(revised).toMatchObject({ outcome: "updated", version: 2 });

    const history = repository.getTargets(COMPANY_A, SALES_A);
    expect(history).toHaveLength(2);
    expect(history.map((target) => target.status)).toEqual([
      "SUPERSEDED",
      "ACTIVE",
    ]);
    expect(history[1]?.previousTargetId).toBe(history[0]?.id);
  });

  it("submit nilai sama idempotent dan tidak membuat versi baru", async () => {
    const repository = readyRepository();
    await repository.initializeFoundation({
      companyId: COMPANY_A,
      actorId: OWNER_A,
    });
    const periodId = await createJulyPeriod(repository);
    const input = {
      companyId: COMPANY_A,
      actorId: OWNER_A,
      periodId,
      salespersonId: SALES_A,
      kpiCode: "EFFECTIVE_CALL" as const,
      targetValue: 12,
      changeReason: "Target awal EC",
    };
    const first = await repository.setTarget(input);
    const second = await repository.setTarget({
      ...input,
      changeReason: "Submit ulang",
    });
    expect(second).toMatchObject({ outcome: "unchanged", version: 1 });
    expect(second).toMatchObject({
      targetId: "targetId" in first ? first.targetId : "",
    });
    expect(repository.getTargets(COMPANY_A, SALES_A)).toHaveLength(1);
  });

  it("target lintas tenant dan user non-sales ditolak", async () => {
    const repository = readyRepository();
    repository.seedSalesperson("not-sales", COMPANY_A, false);
    await repository.initializeFoundation({
      companyId: COMPANY_A,
      actorId: OWNER_A,
    });
    const periodId = await createJulyPeriod(repository);
    const base = {
      companyId: COMPANY_A,
      actorId: OWNER_A,
      periodId,
      kpiCode: "CALL" as const,
      targetValue: 20,
      changeReason: "Target awal",
    };
    await expect(
      repository.setTarget({ ...base, salespersonId: SALES_B }),
    ).resolves.toEqual({ outcome: "salesperson_not_eligible" });
    await expect(
      repository.setTarget({ ...base, salespersonId: "not-sales" }),
    ).resolves.toEqual({ outcome: "salesperson_not_eligible" });
  });

  it("periode LOCKED terminal dan menolak perubahan target", async () => {
    const repository = readyRepository();
    await repository.initializeFoundation({
      companyId: COMPANY_A,
      actorId: OWNER_A,
    });
    const periodId = await createJulyPeriod(repository);
    await repository.setPeriodStatus({
      companyId: COMPANY_A,
      actorId: OWNER_A,
      periodId,
      nextStatus: "ACTIVE",
    });
    await repository.setPeriodStatus({
      companyId: COMPANY_A,
      actorId: OWNER_A,
      periodId,
      nextStatus: "LOCKED",
    });

    await expect(
      repository.setPeriodStatus({
        companyId: COMPANY_A,
        actorId: OWNER_A,
        periodId,
        nextStatus: "ACTIVE",
      }),
    ).resolves.toMatchObject({
      outcome: "invalid_transition",
      status: "LOCKED",
    });
    await expect(
      repository.setTarget({
        companyId: COMPANY_A,
        actorId: OWNER_A,
        periodId,
        salespersonId: SALES_A,
        kpiCode: "CALL",
        targetValue: 20,
        changeReason: "Terlambat input",
      }),
    ).resolves.toEqual({ outcome: "period_locked" });
  });

  it("getter selalu tenant-scoped", async () => {
    const repository = readyRepository();
    repository.seedActor("owner-b", COMPANY_B, "owner");
    await repository.initializeFoundation({
      companyId: COMPANY_A,
      actorId: OWNER_A,
    });
    await repository.initializeFoundation({
      companyId: COMPANY_B,
      actorId: "owner-b",
    });
    expect(repository.getDefinitions(COMPANY_A)).toHaveLength(2);
    expect(repository.getDefinitions(COMPANY_B)).toHaveLength(2);
    expect(
      repository
        .getAuditTrail(COMPANY_A)
        .every((event) => event.companyId === COMPANY_A),
    ).toBe(true);
  });
});
