import { describe, expect, it } from "vitest";
import { InMemoryTodayDeliveryRepository } from "./deliveries";

const COMPANY = "waluyo";
const OTHER_COMPANY = "other-co";
const SALES_1 = "sales-1";
const SALES_2 = "sales-2";

describe("listTodayDeliveries -- 19 (Delivery assignment tampil jika source tersedia)", () => {
  it("delivery non-terminal milik salesman ini muncul", async () => {
    const repo = new InMemoryTodayDeliveryRepository();
    repo.seedDelivery({
      companyId: COMPANY,
      salesOrderId: "order-1",
      assignedDriverId: SALES_1,
      status: "planned",
      orderNumber: "SO-0001",
      customerName: "Toko Sari",
    });
    const result = await repo.listTodayDeliveries(COMPANY, SALES_1);
    expect(result).toHaveLength(1);
    expect(result[0]!.orderNumber).toBe("SO-0001");
  });

  it("delivery dengan status terminal (verified/rejected/dst) TIDAK muncul", async () => {
    const repo = new InMemoryTodayDeliveryRepository();
    repo.seedDelivery({
      companyId: COMPANY,
      salesOrderId: "order-2",
      assignedDriverId: SALES_1,
      status: "verified",
      orderNumber: "SO-0002",
    });
    const result = await repo.listTodayDeliveries(COMPANY, SALES_1);
    expect(result).toHaveLength(0);
  });

  it("delivery milik salesman lain tidak muncul", async () => {
    const repo = new InMemoryTodayDeliveryRepository();
    repo.seedDelivery({
      companyId: COMPANY,
      salesOrderId: "order-3",
      assignedDriverId: SALES_2,
      status: "planned",
      orderNumber: "SO-0003",
    });
    const result = await repo.listTodayDeliveries(COMPANY, SALES_1);
    expect(result).toHaveLength(0);
  });

  it("belum ada assignment (assignedDriverId null) -> empty state jujur, bukan dikarang", async () => {
    const repo = new InMemoryTodayDeliveryRepository();
    repo.seedDelivery({
      companyId: COMPANY,
      salesOrderId: "order-4",
      assignedDriverId: null,
      status: "planned",
      orderNumber: "SO-0004",
    });
    const result = await repo.listTodayDeliveries(COMPANY, SALES_1);
    expect(result).toHaveLength(0);
  });

  it("cross-tenant: delivery company lain tidak pernah muncul", async () => {
    const repo = new InMemoryTodayDeliveryRepository();
    repo.seedDelivery({
      companyId: OTHER_COMPANY,
      salesOrderId: "order-5",
      assignedDriverId: SALES_1,
      status: "planned",
      orderNumber: "SO-0005",
    });
    const result = await repo.listTodayDeliveries(COMPANY, SALES_1);
    expect(result).toHaveLength(0);
  });
});
