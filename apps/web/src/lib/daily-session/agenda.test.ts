import { describe, expect, it } from "vitest";
import { InMemoryAgendaRepository } from "./agenda";

const COMPANY = "waluyo";
const OTHER_COMPANY = "other-co";
const SALES_1 = "sales-1";
const DATE = "2026-07-18";

describe("listTodayStores -- Agenda Hari Ini (8. coverage dan toko tenant benar)", () => {
  it("toko assigned langsung selalu masuk agenda dengan basis ASSIGNED", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCustomer("cust-1", COMPANY, { name: "Toko A", assignedSalesId: SALES_1 });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(1);
    expect(stores[0]!.assignmentBasis).toBe("ASSIGNED");
  });

  it("toko dalam area coverage (tanpa assignment langsung) masuk dengan basis AREA", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCoverageArea(COMPANY, SALES_1, "Utara");
    repo.seedCustomer("cust-2", COMPANY, { name: "Toko B", area: "Utara" });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(1);
    expect(stores[0]!.assignmentBasis).toBe("AREA");
  });

  it("toko assigned ke salesman lain di area coverage TIDAK dobel -- assignment menang", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCoverageArea(COMPANY, SALES_1, "Utara");
    repo.seedCustomer("cust-3", COMPANY, { name: "Toko C", area: "Utara", assignedSalesId: SALES_1 });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(1);
    expect(stores[0]!.assignmentBasis).toBe("ASSIGNED");
  });

  it("toko di luar assignment dan area TIDAK muncul", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCustomer("cust-4", COMPANY, { name: "Toko D", area: "Selatan" });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(0);
  });

  it("toko nonaktif tidak muncul di agenda", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCustomer("cust-5", COMPANY, { name: "Toko E", assignedSalesId: SALES_1, active: false });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(0);
  });

  it("toko yang sudah dikunjungi hari ini ditandai visitedToday=true", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCustomer("cust-6", COMPANY, { name: "Toko F", assignedSalesId: SALES_1 });
    repo.seedVisitedToday(COMPANY, SALES_1, "cust-6", DATE);
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores[0]!.visitedToday).toBe(true);
  });

  it("cross-tenant: toko company lain tidak pernah muncul", async () => {
    const repo = new InMemoryAgendaRepository();
    repo.seedCustomer("cust-7", OTHER_COMPANY, { name: "Toko Lain Tenant", assignedSalesId: SALES_1 });
    const stores = await repo.listTodayStores(COMPANY, SALES_1, DATE);
    expect(stores).toHaveLength(0);
  });
});
