// =============================================================================
// Unit test -- aggregateGovernedKpisBySalesperson (Gate Owner BI-C). Fungsi
// agregasi murni (tanpa I/O) yang mengubah baris sales_kpi_targets/
// sales_kpi_achievement_events menjadi target/achieved/hasTarget per kode KPI
// governed, digroupkan per salesperson_id -- analog dengan aggregateGovernedKpis
// (flowsales.ts, Gate Owner BI-B) yang tenant-wide.
// =============================================================================

import { describe, it, expect } from "vitest";
import { aggregateGovernedKpisBySalesperson } from "./owner-sales-kpi-performance";

describe("aggregateGovernedKpisBySalesperson", () => {
  it("mengembalikan map kosong saat tidak ada baris", () => {
    const result = aggregateGovernedKpisBySalesperson([], []);
    expect(result.size).toBe(0);
  });

  it("salesperson A tidak pernah menerima target/achieved milik salesperson B", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [
        { salesperson_id: "sales-a", target_value: 10, kpi_definition: { code: "CALL" } },
        { salesperson_id: "sales-b", target_value: 99, kpi_definition: { code: "CALL" } },
      ],
      [
        { salesperson_id: "sales-a", kpi_code: "CALL", event_type: "CREDITED", value: 1 },
        { salesperson_id: "sales-b", kpi_code: "CALL", event_type: "CREDITED", value: 5 },
      ],
    );

    expect(result.get("sales-a")?.CALL).toEqual({ target: 10, achieved: 1, hasTarget: true });
    expect(result.get("sales-b")?.CALL).toEqual({ target: 99, achieved: 5, hasTarget: true });
  });

  it("menjumlahkan target_value per salesperson+kode saat ada beberapa baris (mis. revisi target)", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [
        { salesperson_id: "sales-a", target_value: 10, kpi_definition: { code: "REVENUE" } },
        { salesperson_id: "sales-a", target_value: 5, kpi_definition: { code: "REVENUE" } },
      ],
      [],
    );
    expect(result.get("sales-a")?.REVENUE).toEqual({ target: 15, achieved: 0, hasTarget: true });
  });

  it("menangani kpi_definition sebagai array (bentuk join Supabase) dan mengambil elemen pertama", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [{ salesperson_id: "sales-a", target_value: 3, kpi_definition: [{ code: "NOO" }] }],
      [],
    );
    expect(result.get("sales-a")?.NOO).toEqual({ target: 3, achieved: 0, hasTarget: true });
  });

  it("mengabaikan baris target dengan kpi_definition null", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [{ salesperson_id: "sales-a", target_value: 3, kpi_definition: null }],
      [],
    );
    expect(result.get("sales-a")).toBeUndefined();
  });

  it("CREDITED menambah, REVERSED mengurangi achieved -- per kode, per salesperson", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [],
      [
        { salesperson_id: "sales-a", kpi_code: "CALL", event_type: "CREDITED", value: 1 },
        { salesperson_id: "sales-a", kpi_code: "CALL", event_type: "CREDITED", value: 1 },
        { salesperson_id: "sales-a", kpi_code: "CALL", event_type: "REVERSED", value: 1 },
        { salesperson_id: "sales-a", kpi_code: "REVENUE", event_type: "CREDITED", value: 900_000 },
      ],
    );
    expect(result.get("sales-a")?.CALL.achieved).toBe(1);
    expect(result.get("sales-a")?.REVENUE.achieved).toBe(900_000);
    expect(result.get("sales-a")?.ORDER_COUNT.achieved).toBe(0);
  });

  it("mengonversi value string (numeric dari Postgres) menjadi number", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [],
      [{ salesperson_id: "sales-a", kpi_code: "REVENUE", event_type: "CREDITED", value: "900000" }],
    );
    expect(result.get("sales-a")?.REVENUE.achieved).toBe(900_000);
  });

  it("value null diperlakukan sebagai 0", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [],
      [{ salesperson_id: "sales-a", kpi_code: "ORDER_COUNT", event_type: "CREDITED", value: null }],
    );
    expect(result.get("sales-a")?.ORDER_COUNT.achieved).toBe(0);
  });

  it("kelima kode KPI selalu diinisialisasi begitu salesperson punya minimal satu baris", () => {
    const result = aggregateGovernedKpisBySalesperson(
      [{ salesperson_id: "sales-a", target_value: 10, kpi_definition: { code: "CALL" } }],
      [],
    );
    const codes = Object.keys(result.get("sales-a") ?? {});
    expect(codes.sort()).toEqual(["CALL", "EFFECTIVE_CALL", "NOO", "ORDER_COUNT", "REVENUE"]);
  });
});
