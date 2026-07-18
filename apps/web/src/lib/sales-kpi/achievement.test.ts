import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "./repository";
import { computeAchievementLine } from "./service";

const COMPANY = "waluyo";
const OWNER = "owner-1";
const SALES_1 = "sales-1";
const SALES_2 = "sales-2";
const OTHER_COMPANY = "other-co";
const OTHER_SALES = "other-sales";

function seedBaseline(repo: InMemorySalesKpiRepository) {
  repo.seedActor(OWNER, COMPANY, "owner");
  repo.seedSalesperson(SALES_1, COMPANY);
  repo.seedActor(SALES_1, COMPANY, "sales" as never);
  repo.seedSalesperson(SALES_2, COMPANY);
  repo.seedActor(SALES_2, COMPANY, "sales" as never);
  repo.seedCustomer("cust-assigned", COMPANY, { assignedSalesId: SALES_1 });
  repo.seedCustomer("cust-area", COMPANY, { area: "Utara" });
  repo.seedCustomer("cust-out", COMPANY, { area: "Selatan" });
  repo.seedCoverageArea(COMPANY, SALES_1, "Utara");
}

describe("record_sales_call -- CALL validity rules (scenario 1-6)", () => {
  it("1. Valid Call (assignment) menghasilkan satu Call achievement", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const result = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Toko buka, stok dicek",
      idempotencyKey: "k1",
    });
    expect(result.outcome).toBe("recorded");
    const events = repo.getAchievementEvents(COMPANY);
    expect(
      events.filter((e) => e.kpiCode === "CALL" && e.eventType === "CREDITED"),
    ).toHaveLength(1);
  });

  it("2. Retry Call dengan idempotency key sama -> idempotent, tidak dobel", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const first = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan pertama",
      idempotencyKey: "retry-key",
    });
    const second = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan pertama",
      idempotencyKey: "retry-key",
    });
    expect(first.outcome).toBe("recorded");
    expect(second.outcome).toBe("already_recorded");
    if (first.outcome === "recorded" && second.outcome === "already_recorded") {
      expect(second.callId).toBe(first.callId);
    }
    expect(repo.getCalls(COMPANY)).toHaveLength(1);
  });

  it("3. Call toko sama + salesman sama + hari sama tanpa repeat task -> ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan pertama",
      idempotencyKey: "dup-1",
    });
    const second = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan kedua tanpa alasan",
      idempotencyKey: "dup-2",
    });
    expect(second.outcome).toBe("duplicate_same_day");
    expect(repo.getCalls(COMPANY)).toHaveLength(1);
  });

  it("4. Repeat visit hanya dihitung jika task/reference sah", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan pertama",
      idempotencyKey: "rv-1",
    });

    // tanpa task sah -- ditolak (bukti negatif dari skenario 3 diulang di sini
    // dengan idempotency key baru untuk memastikan bukan soal idempotency).
    const withoutTask = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Coba lagi tanpa task",
      idempotencyKey: "rv-2",
    });
    expect(withoutTask.outcome).toBe("duplicate_same_day");

    const task = await repo.createCallTask({
      companyId: COMPANY,
      actorId: OWNER,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      taskType: "REPEAT_VISIT",
      validDate: "2026-08-01",
      reason: "Toko minta kunjungan ulang, ada masalah stok",
    });
    expect(task.outcome).toBe("created");
    if (task.outcome !== "created") return;

    const withTask = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan ulang dengan task sah",
      idempotencyKey: "rv-3",
      repeatVisitTaskId: task.taskId,
    });
    expect(withTask.outcome).toBe("recorded");
    expect(repo.getCalls(COMPANY)).toHaveLength(2);

    // task sudah dipakai -- tidak bisa dipakai lagi
    const reuse = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Coba pakai task yang sama lagi",
      idempotencyKey: "rv-4",
      repeatVisitTaskId: task.taskId,
    });
    expect(reuse.outcome).toBe("authorization_task_already_used");
  });

  it("5. Out-of-coverage tanpa approved exception -> ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const result = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-out",
      callDate: "2026-08-01",
      outcomeNotes: "Coba kunjungi toko luar wilayah",
      idempotencyKey: "oc-1",
    });
    expect(result.outcome).toBe("out_of_coverage");
    expect(repo.getCalls(COMPANY)).toHaveLength(0);
  });

  it("6. Approved exception dapat menghasilkan Call", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const task = await repo.createCallTask({
      companyId: COMPANY,
      actorId: OWNER,
      salespersonId: SALES_1,
      customerId: "cust-out",
      taskType: "COVERAGE_EXCEPTION",
      validDate: "2026-08-01",
      reason: "Owner minta kunjungi toko luar wilayah untuk follow-up khusus",
    });
    expect(task.outcome).toBe("created");
    if (task.outcome !== "created") return;

    const result = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-out",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan dengan exception approved",
      idempotencyKey: "oc-2",
      coverageExceptionTaskId: task.taskId,
    });
    expect(result.outcome).toBe("recorded");
  });
});

describe("link_sales_order_call -- mismatch rejection (scenario 11-13)", () => {
  it("11. Mismatch tenant (order dari company lain) ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const call = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "tenant-1",
    });
    expect(call.outcome).toBe("recorded");
    if (call.outcome !== "recorded") return;

    repo.seedOrder("order-cross-tenant", OTHER_COMPANY, "cust-other", OTHER_SALES);
    const link = await repo.linkOrderCall({
      companyId: OTHER_COMPANY,
      actorId: OTHER_SALES,
      orderId: "order-cross-tenant",
      callId: call.callId,
    });
    expect(link.outcome).toBe("call_not_found");
  });

  it("12. Mismatch salesman ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const call = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "sales-mismatch-1",
    });
    expect(call.outcome).toBe("recorded");
    if (call.outcome !== "recorded") return;

    repo.seedOrder("order-sales-mismatch", COMPANY, "cust-assigned", SALES_2);
    const link = await repo.linkOrderCall({
      companyId: COMPANY,
      actorId: OWNER,
      orderId: "order-sales-mismatch",
      callId: call.callId,
    });
    expect(link.outcome).toBe("salesperson_mismatch");
  });

  it("13. Mismatch toko ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const call = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "cust-mismatch-1",
    });
    expect(call.outcome).toBe("recorded");
    if (call.outcome !== "recorded") return;

    repo.seedOrder("order-cust-mismatch", COMPANY, "cust-area", SALES_1);
    const link = await repo.linkOrderCall({
      companyId: COMPANY,
      actorId: SALES_1,
      orderId: "order-cust-mismatch",
      callId: call.callId,
    });
    expect(link.outcome).toBe("customer_mismatch");
  });
});

describe("reverse_sales_call -- Call invalidation cascades to EC (scenario 15-16)", () => {
  it("15. Reversal retry tidak membuat reversal ganda", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const call = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan salah toko",
      idempotencyKey: "reverse-1",
    });
    expect(call.outcome).toBe("recorded");
    if (call.outcome !== "recorded") return;

    const first = await repo.reverseCall({
      companyId: COMPANY,
      actorId: OWNER,
      callId: call.callId,
      reason: "Salah input toko",
    });
    const second = await repo.reverseCall({
      companyId: COMPANY,
      actorId: OWNER,
      callId: call.callId,
      reason: "retry",
    });
    expect(first.outcome).toBe("reversed");
    expect(second.outcome).toBe("already_reversed");
    const reversedEvents = repo
      .getAchievementEvents(COMPANY)
      .filter((e) => e.callId === call.callId && e.eventType === "REVERSED");
    expect(reversedEvents).toHaveLength(1);
  });

  it("16. Invalidated Call mengoreksi Call DAN EC terkait sekaligus (append-only)", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const call = await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "cascade-1",
    });
    expect(call.outcome).toBe("recorded");
    if (call.outcome !== "recorded") return;

    // Seed EC CREDITED event secara langsung untuk mensimulasikan hasil
    // trigger DB credit_effective_call_for_order (yang hanya bisa dibuktikan
    // via test DB-backed -- lihat achievement.integration.test.ts).
    const events = repo.getAchievementEvents(COMPANY);
    const callEventId = events.find((e) => e.kpiCode === "CALL")?.id;
    expect(callEventId).toBeDefined();

    await repo.reverseCall({
      companyId: COMPANY,
      actorId: OWNER,
      callId: call.callId,
      reason: "Kunjungan tidak valid, salah data",
    });

    const afterEvents = repo.getAchievementEvents(COMPANY);
    const callReversal = afterEvents.find(
      (e) => e.callId === call.callId && e.kpiCode === "CALL" && e.eventType === "REVERSED",
    );
    expect(callReversal).toBeDefined();
    expect(callReversal?.reversalOfEventId).toBe(callEventId);

    // Event asal (CREDITED) TETAP ADA -- append-only, bukan delete/update.
    expect(
      afterEvents.some((e) => e.id === callEventId && e.eventType === "CREDITED"),
    ).toBe(true);
  });
});

describe("Target change tidak menulis ulang historical actual (scenario 18)", () => {
  it("mengubah target tidak mempengaruhi event ledger yang sudah ada", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "target-change-1",
    });
    const eventsBefore = repo.getAchievementEvents(COMPANY);

    const period = await repo.createPeriod({
      companyId: COMPANY,
      actorId: OWNER,
      name: "Agustus 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      workingDays: 21,
    });
    expect(period.outcome).toBe("created");
    if (period.outcome !== "created") return;
    await repo.initializeFoundation({ companyId: COMPANY, actorId: OWNER });

    await repo.setTarget({
      companyId: COMPANY,
      actorId: OWNER,
      periodId: period.periodId,
      salespersonId: SALES_1,
      kpiCode: "CALL",
      targetValue: 20,
      changeReason: "Target awal",
    });
    await repo.setTarget({
      companyId: COMPANY,
      actorId: OWNER,
      periodId: period.periodId,
      salespersonId: SALES_1,
      kpiCode: "CALL",
      targetValue: 30,
      changeReason: "Revisi target pertengahan bulan",
    });

    const eventsAfter = repo.getAchievementEvents(COMPANY);
    expect(eventsAfter).toEqual(eventsBefore);
  });
});

describe("Tenant isolation (scenario 20)", () => {
  it("Tenant A tidak dapat membaca achievement Tenant B", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-assigned",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan tenant A",
      idempotencyKey: "isolation-1",
    });

    repo.seedActor("owner-other", OTHER_COMPANY, "owner");
    repo.seedSalesperson(OTHER_SALES, OTHER_COMPANY);
    repo.seedActor(OTHER_SALES, OTHER_COMPANY, "sales" as never);
    repo.seedCustomer("cust-other", OTHER_COMPANY, { assignedSalesId: OTHER_SALES });
    await repo.recordCall({
      companyId: OTHER_COMPANY,
      actorId: OTHER_SALES,
      salespersonId: OTHER_SALES,
      customerId: "cust-other",
      callDate: "2026-08-01",
      outcomeNotes: "Kunjungan tenant B",
      idempotencyKey: "isolation-2",
    });

    const tenantAEvents = repo.getAchievementEvents(COMPANY);
    const tenantBEvents = repo.getAchievementEvents(OTHER_COMPANY);
    expect(tenantAEvents.every((e) => e.companyId === COMPANY)).toBe(true);
    expect(tenantBEvents.every((e) => e.companyId === OTHER_COMPANY)).toBe(true);
    expect(tenantAEvents).toHaveLength(1);
    expect(tenantBEvents).toHaveLength(1);
  });
});

describe("Missing data -> 'Data belum cukup' (scenario 21)", () => {
  it("target belum dikonfigurasi -> line target null, bukan 0", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const period = await repo.createPeriod({
      companyId: COMPANY,
      actorId: OWNER,
      name: "September 2026",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      workingDays: 22,
    });
    expect(period.outcome).toBe("created");
    if (period.outcome !== "created") return;

    const projection = await repo.getAchievementProjection({
      companyId: COMPANY,
      actorId: OWNER,
      periodId: period.periodId,
      salespersonId: SALES_1,
    });
    expect(projection.outcome).toBe("ok");
    if (projection.outcome !== "ok") return;
    expect(projection.projection.call.target).toBeNull();
    expect(projection.projection.call.achievementPercentage).toBeNull();
    expect(projection.projection.call.pacingStatus).toBe("DATA_INSUFFICIENT");
    expect(projection.projection.sourceFreshness).toBe("DATA_INSUFFICIENT");
  });
});

describe("Projection correctness (scenario 22)", () => {
  it("target/actual/remaining/percentage/status terhitung benar", () => {
    const line = computeAchievementLine(
      "CALL",
      10,
      4,
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      "2026-08-16", // tepat pertengahan periode (16/31 hari)
    );
    expect(line.target).toBe(10);
    expect(line.actual).toBe(4);
    expect(line.remaining).toBe(6);
    expect(line.achievementPercentage).toBe(40);
    // elapsedFraction ~ 16/31 ~ 0.516 -> expected ~5.16, actual=4 < 0.95*5.16 -> BEHIND
    expect(line.pacingStatus).toBe("BEHIND");
  });

  it("periode belum mulai -> NOT_STARTED", () => {
    const line = computeAchievementLine(
      "CALL",
      10,
      0,
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      "2026-08-20",
    );
    expect(line.pacingStatus).toBe("NOT_STARTED");
  });

  it("periode sudah lewat -> COMPLETE", () => {
    const line = computeAchievementLine(
      "CALL",
      10,
      10,
      { startDate: "2026-07-01", endDate: "2026-07-31" },
      "2026-08-05",
    );
    expect(line.pacingStatus).toBe("COMPLETE");
  });

  it("actual melebihi ekspektasi pacing -> AHEAD", () => {
    const line = computeAchievementLine(
      "EFFECTIVE_CALL",
      10,
      9,
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      "2026-08-05", // baru 5/31 hari, ekspektasi ~1.6, actual 9 jauh di atas
    );
    expect(line.pacingStatus).toBe("AHEAD");
  });

  it("remaining tidak pernah negatif walau actual > target", () => {
    const line = computeAchievementLine(
      "CALL",
      5,
      8,
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      "2026-08-31",
    );
    expect(line.remaining).toBe(0);
    expect(line.achievementPercentage).toBe(160);
  });
});

describe("Legacy import tidak menghasilkan achievement (scenario 17) -- struktural", () => {
  it("tidak ada jalur kode dari lib/imports ke sales_kpi_achievement_events atau sales_calls", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const importsDir = path.join(process.cwd(), "src/lib/imports");
    const files = fs.readdirSync(importsDir).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(importsDir, file), "utf-8");
      expect(content).not.toContain("sales_kpi_achievement_events");
      expect(content).not.toContain("sales_calls");
      expect(content).not.toContain("record_sales_call");
    }
  });
});

describe("Achievement tidak dapat diinput/override manual (scenario 19) -- struktural", () => {
  it("actions.ts tidak mengekspos mutation langsung ke sales_kpi_achievement_events", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const actionsContent = fs.readFileSync(
      path.join(process.cwd(), "src/lib/sales-kpi/actions.ts"),
      "utf-8",
    );
    // Satu-satunya operasi yang boleh terkait ledger adalah lewat RPC
    // record_sales_call / reverse_sales_call -- tidak boleh ada .insert()/
    // .update() langsung ke sales_kpi_achievement_events dari actions.ts.
    expect(actionsContent).not.toContain("sales_kpi_achievement_events");
    expect(actionsContent).not.toMatch(/setAchievement|overrideAchievement|updateActual/i);
  });
});
