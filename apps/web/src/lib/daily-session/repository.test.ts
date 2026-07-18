import { describe, expect, it } from "vitest";
import { InMemoryDailySessionRepository } from "./repository";
import { dailySessionIdempotencyKey } from "./service";

const COMPANY = "waluyo";
const OTHER_COMPANY = "other-co";
const OWNER = "owner-1";
const MANAGER = "manager-1";
const SALES_1 = "sales-1";
const SALES_2 = "sales-2";
const DATE = "2026-07-18";

function seedBaseline(repo: InMemoryDailySessionRepository) {
  repo.seedActor(OWNER, COMPANY, "owner");
  repo.seedActor(MANAGER, COMPANY, "manager");
  repo.seedSalesman(SALES_1, COMPANY);
  repo.seedActor(SALES_1, COMPANY, "sales");
  repo.seedSalesman(SALES_2, COMPANY);
  repo.seedActor(SALES_2, COMPANY, "sales");
}

describe("start_daily_session (6, 7 -- Mulai Hari lifecycle)", () => {
  it("6. Mulai Hari membuat satu session ACTIVE", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    expect(result.outcome).toBe("started");
    const session = await repo.findForBusinessDate(COMPANY, SALES_1, DATE);
    expect(session?.status).toBe("ACTIVE");
  });

  it("7. Mulai Hari dua kali tetap satu session (idempotent)", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const first = await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    const second = await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("already_started");
    if (first.outcome === "started" && second.outcome === "already_started") {
      expect(second.sessionId).toBe(first.sessionId);
    }
    expect(repo.getSessions(COMPANY)).toHaveLength(1);
  });

  it("beda salesman/beda tanggal -> session terpisah", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    await repo.start({
      companyId: COMPANY,
      actorId: SALES_2,
      salesmanId: SALES_2,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_2, DATE),
    });
    expect(repo.getSessions(COMPANY)).toHaveLength(2);
  });

  it("salesman tidak bisa membuka session salesman lain", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_2,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_2, DATE),
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("manager/owner boleh membuka session atas nama salesman", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: MANAGER,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    expect(result.outcome).toBe("started");
  });

  it("salesperson_not_eligible untuk user bukan role sales", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: OWNER,
      salesmanId: OWNER,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(OWNER, DATE),
    });
    expect(result.outcome).toBe("salesperson_not_eligible");
  });

  it("anonymous/actor tidak dikenal ditolak", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: "unknown-actor",
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("cross-tenant: actor dari company lain ditolak", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    repo.seedActor("outsider", OTHER_COMPANY, "owner");
    const result = await repo.start({
      companyId: COMPANY,
      actorId: "outsider",
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    expect(result.outcome).toBe("forbidden");
  });
});

describe("close_daily_session / reopen_daily_session (21-23 -- Tutup Hari lifecycle)", () => {
  async function startedSession(repo: InMemoryDailySessionRepository) {
    seedBaseline(repo);
    const result = await repo.start({
      companyId: COMPANY,
      actorId: SALES_1,
      salesmanId: SALES_1,
      businessDate: DATE,
      idempotencyKey: dailySessionIdempotencyKey(SALES_1, DATE),
    });
    if (result.outcome !== "started") throw new Error("seed gagal");
    return result.sessionId;
  }

  it("22. Tutup Hari berhasil menutup session ACTIVE", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    const result = await repo.close({
      companyId: COMPANY,
      actorId: SALES_1,
      sessionId,
      closeSummary: { callCount: 2 },
    });
    expect(result.outcome).toBe("closed");
    const session = await repo.findForBusinessDate(COMPANY, SALES_1, DATE);
    expect(session?.status).toBe("CLOSED");
    expect(session?.closeSummary).toEqual({ callCount: 2 });
  });

  it("23. Tutup Hari dua kali idempotent (already_closed, tidak error)", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    const first = await repo.close({ companyId: COMPANY, actorId: SALES_1, sessionId });
    const second = await repo.close({ companyId: COMPANY, actorId: SALES_1, sessionId });
    expect(first.outcome).toBe("closed");
    expect(second.outcome).toBe("already_closed");
  });

  it("session tidak ditemukan -> session_not_found", async () => {
    const repo = new InMemoryDailySessionRepository();
    seedBaseline(repo);
    const result = await repo.close({
      companyId: COMPANY,
      actorId: SALES_1,
      sessionId: "missing",
    });
    expect(result.outcome).toBe("session_not_found");
  });

  it("salesman lain tidak bisa menutup session milik orang lain", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    const result = await repo.close({ companyId: COMPANY, actorId: SALES_2, sessionId });
    expect(result.outcome).toBe("forbidden");
  });

  it("reopen_daily_session: manager boleh, sales tidak boleh", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    await repo.close({ companyId: COMPANY, actorId: SALES_1, sessionId });

    const bySales = await repo.reopen({
      companyId: COMPANY,
      actorId: SALES_1,
      sessionId,
      reason: "salah tutup",
    });
    expect(bySales.outcome).toBe("forbidden");

    const byManager = await repo.reopen({
      companyId: COMPANY,
      actorId: MANAGER,
      sessionId,
      reason: "salah tutup, koreksi manager",
    });
    expect(byManager.outcome).toBe("reopened");
    const session = await repo.findForBusinessDate(COMPANY, SALES_1, DATE);
    expect(session?.status).toBe("ACTIVE");
    expect(session?.closeSummary).toBeNull();
  });

  it("reopen tanpa alasan memadai -> reason_required", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    await repo.close({ companyId: COMPANY, actorId: SALES_1, sessionId });
    const result = await repo.reopen({
      companyId: COMPANY,
      actorId: MANAGER,
      sessionId,
      reason: "x",
    });
    expect(result.outcome).toBe("reason_required");
  });

  it("reopen session yang masih ACTIVE -> already_active", async () => {
    const repo = new InMemoryDailySessionRepository();
    const sessionId = await startedSession(repo);
    const result = await repo.reopen({
      companyId: COMPANY,
      actorId: MANAGER,
      sessionId,
      reason: "koreksi sebelum tutup",
    });
    expect(result.outcome).toBe("already_active");
  });
});
