import { describe, it, expect } from "vitest";
import { evaluateKpiPeriodHealth, type KpiPeriodRow } from "./period-health";

const aug: KpiPeriodRow = { name: "Agustus 2026", start_date: "2026-08-01", end_date: "2026-08-31", status: "ACTIVE" };

describe("evaluateKpiPeriodHealth", () => {
  it("ok bila periode ACTIVE mencakup hari ini dan masih >3 hari", () => {
    expect(evaluateKpiPeriodHealth([aug], "2026-08-10")).toMatchObject({ status: "ok", daysLeft: 21 });
  });
  it("ending_soon bila sisa <=3 hari", () => {
    expect(evaluateKpiPeriodHealth([aug], "2026-08-29")).toMatchObject({ status: "ending_soon", daysLeft: 2 });
  });
  it("missing bila periode ACTIVE sudah lewat (kasus produksi Okt 2026)", () => {
    expect(evaluateKpiPeriodHealth([aug], "2026-10-29")).toEqual({ status: "missing", lastEndDate: "2026-08-31" });
  });
  it("missing bila tidak ada periode sama sekali", () => {
    expect(evaluateKpiPeriodHealth([], "2026-10-29")).toEqual({ status: "missing", lastEndDate: null });
  });
  it("periode DRAFT/LOCKED tidak dihitung walau tanggalnya mencakup", () => {
    expect(evaluateKpiPeriodHealth([{ ...aug, status: "DRAFT" }], "2026-08-10").status).toBe("missing");
  });
});
