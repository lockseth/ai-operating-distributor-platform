import { describe, expect, it } from "vitest";
import { InMemoryTodayOrdersRepository } from "./orders";

const COMPANY = "waluyo";
const SALES_1 = "sales-1";
const DATE = "2026-07-18";

describe("countConfirmedToday -- Order confirmed hari ini (End-of-Day Summary, confirmed_at authoritative)", () => {
  it("menghitung order confirmed_at pada business date Jakarta yang sama", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    repo.seedOrder(COMPANY, SALES_1, "confirmed", `${DATE}T03:00:00Z`);
    repo.seedOrder(COMPANY, SALES_1, "confirmed", `${DATE}T10:00:00Z`);
    const count = await repo.countConfirmedToday(COMPANY, SALES_1, DATE);
    expect(count).toBe(2);
  });

  it("order draft/cancelled tidak dihitung meski confirmedAt terisi", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    repo.seedOrder(COMPANY, SALES_1, "draft", null);
    repo.seedOrder(COMPANY, SALES_1, "cancelled", `${DATE}T03:00:00Z`);
    const count = await repo.countConfirmedToday(COMPANY, SALES_1, DATE);
    expect(count).toBe(0);
  });

  it("confirmed_at tanggal Jakarta lain tidak dihitung", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    repo.seedOrder(COMPANY, SALES_1, "confirmed", "2026-07-17T03:00:00Z");
    const count = await repo.countConfirmedToday(COMPANY, SALES_1, DATE);
    expect(count).toBe(0);
  });

  it("order salesman lain tidak dihitung", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    repo.seedOrder(COMPANY, "sales-2", "confirmed", `${DATE}T03:00:00Z`);
    const count = await repo.countConfirmedToday(COMPANY, SALES_1, DATE);
    expect(count).toBe(0);
  });

  it("order confirmed=true tapi confirmedAt null (historical, tidak dikarang) tidak dihitung", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    repo.seedOrder(COMPANY, SALES_1, "confirmed", null);
    const count = await repo.countConfirmedToday(COMPANY, SALES_1, DATE);
    expect(count).toBe(0);
  });

  it("lintas tengah malam UTC/Jakarta: confirmed_at UTC 17:30 (WIB 00:30 keesokan hari) terhitung di businessDate berikutnya, bukan hari UTC-nya", async () => {
    const repo = new InMemoryTodayOrdersRepository();
    // 2026-07-18T17:30:00Z = 2026-07-19 00:30 WIB (UTC+7) -> business date 19, bukan 18.
    repo.seedOrder(COMPANY, SALES_1, "confirmed", "2026-07-18T17:30:00Z");
    expect(await repo.countConfirmedToday(COMPANY, SALES_1, "2026-07-18")).toBe(0);
    expect(await repo.countConfirmedToday(COMPANY, SALES_1, "2026-07-19")).toBe(1);
  });
});
