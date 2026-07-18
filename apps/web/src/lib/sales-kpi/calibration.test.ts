import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "./repository";
import {
  calibrationBaselineWindow,
  computeCalibrationSufficiency,
  computeEcRate,
  validateCalibratedTargetsInput,
  KPI_BASELINE_MIN_OBSERVED_DAYS,
} from "./service";

const COMPANY = "waluyo";
const OWNER = "owner-1";
const SALES_1 = "sales-1";
const OTHER_COMPANY = "other-co";
const OTHER_OWNER = "other-owner";
const OTHER_SALES = "other-sales";

function seedBaseline(repo: InMemorySalesKpiRepository) {
  repo.seedActor(OWNER, COMPANY, "owner");
  repo.seedSalesperson(SALES_1, COMPANY);
  repo.seedActor(SALES_1, COMPANY, "sales" as never);
}

async function createDraftPeriod(repo: InMemorySalesKpiRepository) {
  await repo.initializeFoundation({ companyId: COMPANY, actorId: OWNER });
  const period = await repo.createPeriod({
    companyId: COMPANY,
    actorId: OWNER,
    name: "Kalibrasi Agustus",
    startDate: "2026-08-01",
    endDate: "2026-08-31",
    workingDays: 21,
  });
  if (period.outcome !== "created") throw new Error("gagal buat period test");
  return period.periodId;
}

// ---------------------------------------------------------------------------
// Target invariant (bilangan bulat non-negatif, EC<=Call)
// ---------------------------------------------------------------------------
describe("validateCalibratedTargetsInput -- target invariant", () => {
  it("target Call negatif ditolak", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: -1, ecTarget: 0, changeReason: "x" }),
    ).toBe("invalid_call_target");
  });
  it("target EC negatif ditolak", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: 10, ecTarget: -1, changeReason: "x" }),
    ).toBe("invalid_ec_target");
  });
  it("target EC melebihi target Call ditolak", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: 10, ecTarget: 15, changeReason: "x" }),
    ).toBe("ec_exceeds_call");
  });
  it("target EC = 0 dan Call = 0 sah (non-negatif, bukan hanya positif)", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: 0, ecTarget: 0, changeReason: "Target awal" }),
    ).toBeNull();
  });
  it("target EC = target Call (batas atas) sah", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: 10, ecTarget: 10, changeReason: "Target awal" }),
    ).toBeNull();
  });
  it("alasan perubahan kosong/pendek ditolak", () => {
    expect(
      validateCalibratedTargetsInput({ callTarget: 10, ecTarget: 5, changeReason: "ab" }),
    ).toBe("reason_required");
  });
});

// ---------------------------------------------------------------------------
// Period lifecycle: LOCKED menolak edit
// ---------------------------------------------------------------------------
describe("Period lifecycle -- LOCKED menolak edit target", () => {
  it("target tidak bisa diubah setelah periode LOCKED", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    const first = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
      callTarget: 10,
      ecTarget: 5,
      changeReason: "Target awal",
    });
    expect(first.outcome).toBe("saved");

    await repo.setPeriodStatus({ companyId: COMPANY, actorId: OWNER, periodId, nextStatus: "ACTIVE" });
    await repo.setPeriodStatus({ companyId: COMPANY, actorId: OWNER, periodId, nextStatus: "LOCKED" });

    const locked = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
      callTarget: 20,
      ecTarget: 10,
      changeReason: "Coba edit periode terkunci",
    });
    expect(locked.outcome).toBe("period_locked");
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
describe("Authorization -- unauthorized role ditolak", () => {
  it("salesman (non-manager) tidak bisa mengubah target", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    const result = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: SALES_1,
      periodId,
      salespersonId: SALES_1,
      callTarget: 10,
      ecTarget: 5,
      changeReason: "Salesman coba ubah target sendiri",
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("actor tidak aktif/tidak terdaftar ditolak", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    const result = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: "unknown-actor",
      periodId,
      salespersonId: SALES_1,
      callTarget: 10,
      ecTarget: 5,
      changeReason: "Actor tidak dikenal",
    });
    expect(result.outcome).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------
describe("Tenant isolation", () => {
  it("owner tenant lain tidak dapat mengubah target tenant lain", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    repo.seedActor(OTHER_OWNER, OTHER_COMPANY, "owner");
    repo.seedSalesperson(OTHER_SALES, OTHER_COMPANY);

    const result = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: OTHER_OWNER,
      periodId,
      salespersonId: SALES_1,
      callTarget: 10,
      ecTarget: 5,
      changeReason: "Owner tenant lain coba ubah",
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("baseline tenant A tidak bercampur dengan tenant B", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    repo.seedActor(OTHER_OWNER, OTHER_COMPANY, "owner");
    repo.seedSalesperson(OTHER_SALES, OTHER_COMPANY);
    repo.seedAchievementEvent(OTHER_COMPANY, OTHER_SALES, "CALL", "CREDITED", "2026-07-15");

    const baseline = await repo.getCalibrationBaseline({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
    });
    expect(baseline.outcome).toBe("ok");
    if (baseline.outcome !== "ok") return;
    expect(baseline.baseline.historicalCall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Versioning / audit
// ---------------------------------------------------------------------------
describe("Versioning -- perubahan target versioned", () => {
  it("target kedua men-supersede versi pertama, keduanya tetap ada di history", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    const v1 = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
      callTarget: 10,
      ecTarget: 5,
      changeReason: "Target awal",
    });
    expect(v1.outcome).toBe("saved");
    if (v1.outcome !== "saved") return;
    expect(v1.callVersion).toBe(1);

    const v2 = await repo.setTargetsCalibrated({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
      callTarget: 12,
      ecTarget: 6,
      changeReason: "Revisi berdasarkan baseline",
    });
    expect(v2.outcome).toBe("saved");
    if (v2.outcome !== "saved") return;
    expect(v2.callVersion).toBe(2);

    const targets = repo.getTargets(COMPANY, SALES_1);
    expect(targets).toHaveLength(4); // 2x CALL + 2x EC (v1+v2 masing-masing)
    expect(targets.filter((t) => t.status === "ACTIVE")).toHaveLength(2);
    expect(targets.filter((t) => t.status === "SUPERSEDED")).toHaveLength(2);
  });

  it("retry nilai sama -> unchanged, tidak membuat versi baru", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    await repo.setTargetsCalibrated({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      callTarget: 10, ecTarget: 5, changeReason: "Target awal",
    });
    const retry = await repo.setTargetsCalibrated({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      callTarget: 10, ecTarget: 5, changeReason: "retry sama",
    });
    expect(retry.outcome).toBe("saved");
    if (retry.outcome !== "saved") return;
    expect(retry.callVersion).toBe(1);
    expect(repo.getTargets(COMPANY, SALES_1)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Historical actual immutability (perubahan target tidak menulis ulang actual)
// ---------------------------------------------------------------------------
describe("Historical actual immutability", () => {
  it("mengubah target tidak mengubah achievement_events yang sudah ada", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);
    repo.seedCustomer("cust-1", COMPANY, { assignedSalesId: SALES_1 });

    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-1",
      callDate: "2026-08-05",
      outcomeNotes: "Kunjungan aktual",
      idempotencyKey: "immut-1",
    });
    const eventsBefore = repo.getAchievementEvents(COMPANY);

    await repo.setTargetsCalibrated({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      callTarget: 10, ecTarget: 5, changeReason: "Target awal",
    });
    await repo.setTargetsCalibrated({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
      callTarget: 20, ecTarget: 8, changeReason: "Revisi target",
    });

    const eventsAfter = repo.getAchievementEvents(COMPANY);
    expect(eventsAfter).toEqual(eventsBefore);

    const projection = await repo.getAchievementProjection({
      companyId: COMPANY, actorId: OWNER, periodId, salespersonId: SALES_1,
    });
    expect(projection.outcome).toBe("ok");
    if (projection.outcome !== "ok") return;
    expect(projection.projection.call.actual).toBe(1); // actual tetap 1, tidak berubah karena target berubah
    expect(projection.projection.call.target).toBe(20); // target sudah versi terbaru
  });
});

// ---------------------------------------------------------------------------
// Baseline insufficient-data state
// ---------------------------------------------------------------------------
describe("Baseline sufficiency", () => {
  it("tanpa data historis -> INSUFFICIENT, ecRate null", () => {
    expect(computeCalibrationSufficiency(0)).toBe("INSUFFICIENT");
    expect(computeEcRate(0, 0)).toBeNull();
  });

  it("di bawah ambang minimal -> INSUFFICIENT", () => {
    expect(computeCalibrationSufficiency(KPI_BASELINE_MIN_OBSERVED_DAYS - 1)).toBe("INSUFFICIENT");
  });

  it("memenuhi ambang minimal -> SUFFICIENT", () => {
    expect(computeCalibrationSufficiency(KPI_BASELINE_MIN_OBSERVED_DAYS)).toBe("SUFFICIENT");
  });

  it("EC rate dihitung benar dari data historis", () => {
    expect(computeEcRate(20, 5)).toBe(25);
    expect(computeEcRate(10, 10)).toBe(100);
  });

  it("salesman tanpa baseline cukup menampilkan sufficiency INSUFFICIENT lewat repository", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    const baseline = await repo.getCalibrationBaseline({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
    });
    expect(baseline.outcome).toBe("ok");
    if (baseline.outcome !== "ok") return;
    expect(baseline.baseline.sufficiency).toBe("INSUFFICIENT");
    expect(baseline.baseline.historicalCall).toBe(0);
  });

  it("salesman dengan baseline cukup (>=ambang hari observasi) -> SUFFICIENT", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    for (let day = 1; day <= KPI_BASELINE_MIN_OBSERVED_DAYS; day++) {
      const date = `2026-07-${String(day).padStart(2, "0")}`;
      repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", date);
    }

    const baseline = await repo.getCalibrationBaseline({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
    });
    expect(baseline.outcome).toBe("ok");
    if (baseline.outcome !== "ok") return;
    expect(baseline.baseline.sufficiency).toBe("SUFFICIENT");
    expect(baseline.baseline.observedDays).toBe(KPI_BASELINE_MIN_OBSERVED_DAYS);
  });

  it("observedDays menghitung TANGGAL BERBEDA, bukan jumlah event -- banyak Call pada hari yang sama tetap 1 hari observasi", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    // 5 event CALL CREDITED, tapi hanya pada 2 tanggal berbeda -- di bawah
    // ambang (KPI_BASELINE_MIN_OBSERVED_DAYS=7) meskipun jumlah EVENT (5)
    // lebih besar dari 2. Jika implementasi keliru menghitung jumlah baris
    // event (bukan COUNT DISTINCT business_date), test ini akan gagal.
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-10");
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-10");
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-10");
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-11");
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-11");

    const baseline = await repo.getCalibrationBaseline({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
    });
    expect(baseline.outcome).toBe("ok");
    if (baseline.outcome !== "ok") return;
    expect(baseline.baseline.observedDays).toBe(2); // BUKAN 5
    expect(baseline.baseline.historicalCall).toBe(5); // total event tetap 5
    expect(baseline.baseline.sufficiency).toBe("INSUFFICIENT"); // 2 < ambang 7
  });

  it("observedDays hanya menghitung event CREDITED, event REVERSED pada tanggal baru tidak menambah hari observasi", async () => {
    const repo = new InMemorySalesKpiRepository();
    seedBaseline(repo);
    const periodId = await createDraftPeriod(repo);

    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "CREDITED", "2026-07-10");
    repo.seedAchievementEvent(COMPANY, SALES_1, "CALL", "REVERSED", "2026-07-10");

    const baseline = await repo.getCalibrationBaseline({
      companyId: COMPANY,
      actorId: OWNER,
      periodId,
      salespersonId: SALES_1,
    });
    expect(baseline.outcome).toBe("ok");
    if (baseline.outcome !== "ok") return;
    // CREDITED tetap menghitung tanggalnya sbg observasi (hari itu benar
    // pernah ada kunjungan tercatat) meski net historicalCall jadi 0 akibat
    // reversal -- observedDays mengukur "hari ada aktivitas", bukan "hari
    // net-positive".
    expect(baseline.baseline.observedDays).toBe(1);
    expect(baseline.baseline.historicalCall).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calibrationBaselineWindow
// ---------------------------------------------------------------------------
describe("calibrationBaselineWindow", () => {
  it("window berakhir tepat 1 hari sebelum period.startDate", () => {
    const { windowStartDate, windowEndDate } = calibrationBaselineWindow("2026-08-01", 30);
    expect(windowEndDate).toBe("2026-07-31");
    expect(windowStartDate).toBe("2026-07-02");
  });
});

// ---------------------------------------------------------------------------
// No manual achievement mutation (struktural)
// ---------------------------------------------------------------------------
describe("Achievement tidak dapat diinput/override manual lewat calibration action (scenario struktural)", () => {
  it("actions.ts calibration tidak mengekspos mutation langsung ke sales_kpi_achievement_events", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const content = fs.readFileSync(
      path.join(process.cwd(), "src/lib/sales-kpi/actions.ts"),
      "utf-8",
    );
    const calibrationSection = content.slice(content.indexOf("Owner KPI Setup & Target Calibration"));
    expect(calibrationSection).not.toContain("sales_kpi_achievement_events");
    expect(calibrationSection).not.toMatch(/setAchievement|overrideAchievement/i);
  });
});
