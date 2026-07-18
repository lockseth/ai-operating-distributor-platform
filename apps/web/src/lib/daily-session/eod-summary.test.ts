import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "@/lib/sales-kpi/repository";
import { InMemoryAgendaRepository } from "./agenda";
import { InMemoryTodayDeliveryRepository } from "./deliveries";
import { InMemoryTodayOrdersRepository } from "./orders";
import { composeEndOfDaySummary } from "./eod-summary";

const COMPANY = "waluyo";
const OWNER = "owner-1";
const SALES_1 = "sales-1";
const DATE = "2026-08-10";

describe("composeEndOfDaySummary -- 24 (End-of-Day Summary cocok dengan ledger KPI)", () => {
  it("tanpa periode ACTIVE -> Call/EC 0, tidak mengarang target", async () => {
    const salesKpiRepository = new InMemorySalesKpiRepository();
    const agendaRepository = new InMemoryAgendaRepository();
    const todayDeliveryRepository = new InMemoryTodayDeliveryRepository();
    const todayOrdersRepository = new InMemoryTodayOrdersRepository();

    const { summary, text } = await composeEndOfDaySummary(
      { companyId: COMPANY, actorId: SALES_1, salesmanId: SALES_1, businessDate: DATE },
      { salesKpiRepository, agendaRepository, todayDeliveryRepository, todayOrdersRepository },
    );

    expect(summary.callTarget).toBeNull();
    expect(summary.callActual).toBe(0);
    expect(summary.ecRate).toBeNull();
    expect(text).toContain("Data AR/tagihan belum tersedia");
  });

  it("dengan Call tercatat, order confirmed, delivery campuran, agenda sebagian -> angka sesuai fixture", async () => {
    const salesKpiRepository = new InMemorySalesKpiRepository();
    salesKpiRepository.seedActor(OWNER, COMPANY, "owner");
    salesKpiRepository.seedSalesperson(SALES_1, COMPANY);
    salesKpiRepository.seedActor(SALES_1, COMPANY, "sales" as never);
    salesKpiRepository.seedCustomer("cust-1", COMPANY, { assignedSalesId: SALES_1 });
    salesKpiRepository.seedCustomer("cust-2", COMPANY, { assignedSalesId: SALES_1 });
    await salesKpiRepository.initializeFoundation({ companyId: COMPANY, actorId: OWNER });
    const period = await salesKpiRepository.createPeriod({
      companyId: COMPANY,
      actorId: OWNER,
      name: "Agustus 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      workingDays: 26,
    });
    if (period.outcome !== "created") throw new Error("seed periode gagal");
    await salesKpiRepository.setPeriodStatus({ companyId: COMPANY, actorId: OWNER, periodId: period.periodId, nextStatus: "ACTIVE" });
    await salesKpiRepository.setTarget({
      companyId: COMPANY, actorId: OWNER, periodId: period.periodId, salespersonId: SALES_1,
      kpiCode: "CALL", targetValue: 10, changeReason: "target",
    });
    await salesKpiRepository.recordCall({
      companyId: COMPANY, actorId: SALES_1, salespersonId: SALES_1, customerId: "cust-1",
      callDate: DATE, outcomeNotes: "Kunjungan pagi", idempotencyKey: "call-1",
    });

    const agendaRepository = new InMemoryAgendaRepository();
    agendaRepository.seedCustomer("cust-1", COMPANY, { name: "Toko A", assignedSalesId: SALES_1 });
    agendaRepository.seedCustomer("cust-2", COMPANY, { name: "Toko B", assignedSalesId: SALES_1 });
    agendaRepository.seedVisitedToday(COMPANY, SALES_1, "cust-1", DATE);

    const todayDeliveryRepository = new InMemoryTodayDeliveryRepository();
    todayDeliveryRepository.seedDelivery({
      companyId: COMPANY, salesOrderId: "order-1", assignedDriverId: SALES_1, status: "verified", orderNumber: "SO-0001",
    });
    todayDeliveryRepository.seedDelivery({
      companyId: COMPANY, salesOrderId: "order-2", assignedDriverId: SALES_1, status: "dispatched", orderNumber: "SO-0002",
    });

    const todayOrdersRepository = new InMemoryTodayOrdersRepository();
    todayOrdersRepository.seedOrder(COMPANY, SALES_1, "confirmed", `${DATE}T05:00:00Z`);

    const { summary, text } = await composeEndOfDaySummary(
      { companyId: COMPANY, actorId: SALES_1, salesmanId: SALES_1, businessDate: DATE },
      { salesKpiRepository, agendaRepository, todayDeliveryRepository, todayOrdersRepository },
    );

    expect(summary.callActual).toBe(1);
    expect(summary.callTarget).toBe(10);
    expect(summary.ordersConfirmedToday).toBe(1);
    expect(summary.deliveriesCompleted).toBe(1);
    expect(summary.deliveriesPending).toBe(1);
    expect(summary.unfinishedStores).toEqual(["Toko B"]);
    expect(text).toContain("Toko B");
    expect(text).toContain("Order confirmed: 1");
  });
});
