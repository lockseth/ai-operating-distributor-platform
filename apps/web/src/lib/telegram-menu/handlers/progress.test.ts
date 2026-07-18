import { describe, expect, it } from "vitest";
import { InMemorySalesKpiRepository } from "@/lib/sales-kpi/repository";
import { buildProgressMessage } from "./progress";

const COMPANY = "waluyo";
const OWNER = "owner-1";
const SALES_1 = "sales-1";

describe("Target & Pencapaian -- presenter tipis (tidak menghitung Call/EC/EC Rate sendiri)", () => {
  it("tanpa periode ACTIVE -> pesan eksplisit, bukan angka 0", async () => {
    const repo = new InMemorySalesKpiRepository();
    const message = await buildProgressMessage(
      { companyId: COMPANY, actorId: SALES_1, salesmanId: SALES_1 },
      { salesKpiRepository: repo },
    );
    expect(message).toContain("belum diaktifkan");
    expect(message).toContain("bukan berarti target 0");
  });

  it("dengan periode ACTIVE dan Call/EC tercatat -> angka sama persis dengan projection", async () => {
    const repo = new InMemorySalesKpiRepository();
    repo.seedActor(OWNER, COMPANY, "owner");
    repo.seedSalesperson(SALES_1, COMPANY);
    repo.seedActor(SALES_1, COMPANY, "sales" as never);
    repo.seedCustomer("cust-1", COMPANY, { assignedSalesId: SALES_1 });
    await repo.initializeFoundation({ companyId: COMPANY, actorId: OWNER });
    const period = await repo.createPeriod({
      companyId: COMPANY,
      actorId: OWNER,
      name: "Agustus 2026",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      workingDays: 26,
    });
    if (period.outcome !== "created") throw new Error("seed periode gagal");
    await repo.setPeriodStatus({ companyId: COMPANY, actorId: OWNER, periodId: period.periodId, nextStatus: "ACTIVE" });
    await repo.setTarget({
      companyId: COMPANY,
      actorId: OWNER,
      periodId: period.periodId,
      salespersonId: SALES_1,
      kpiCode: "CALL",
      targetValue: 10,
      changeReason: "target awal",
    });
    await repo.recordCall({
      companyId: COMPANY,
      actorId: SALES_1,
      salespersonId: SALES_1,
      customerId: "cust-1",
      callDate: "2026-08-10",
      outcomeNotes: "Kunjungan",
      idempotencyKey: "call-1",
    });

    const message = await buildProgressMessage(
      { companyId: COMPANY, actorId: SALES_1, salesmanId: SALES_1 },
      { salesKpiRepository: repo },
    );
    expect(message).toContain("Agustus 2026");
    expect(message).toContain("1/10");
    expect(message).toContain("Data belum cukup"); // EC target belum diset
  });
});
