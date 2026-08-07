// =============================================================================
// Unit test -- aggregateGovernedKpis (Gate Owner BI-B). Fungsi agregasi murni
// (tanpa I/O) yang mengubah baris sales_kpi_targets/sales_kpi_achievement_events
// menjadi target/achieved/hasTarget per kode KPI governed
// (CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE/NOO).
// =============================================================================

import { describe, it, expect } from "vitest";
import { aggregateGovernedKpis } from "./flowsales";

describe("aggregateGovernedKpis", () => {
  it("mengembalikan target=0/achieved=0/hasTarget=false untuk kelima kode saat tidak ada baris", () => {
    const result = aggregateGovernedKpis([], []);
    for (const code of ["CALL", "EFFECTIVE_CALL", "ORDER_COUNT", "REVENUE", "NOO"] as const) {
      expect(result[code]).toEqual({ target: 0, achieved: 0, hasTarget: false });
    }
  });

  it("menjumlahkan target_value lintas salesperson per kode KPI (agregat tenant-wide)", () => {
    const result = aggregateGovernedKpis(
      [
        { target_value: 10, kpi_definition: { code: "CALL" } },
        { target_value: 15, kpi_definition: { code: "CALL" } },
        { target_value: 1_000_000, kpi_definition: { code: "REVENUE" } },
      ],
      [],
    );
    expect(result.CALL.target).toBe(25);
    expect(result.CALL.hasTarget).toBe(true);
    expect(result.REVENUE.target).toBe(1_000_000);
    expect(result.EFFECTIVE_CALL.hasTarget).toBe(false);
  });

  it("menangani kpi_definition sebagai array (bentuk join Supabase) dan mengambil elemen pertama", () => {
    const result = aggregateGovernedKpis(
      [{ target_value: 5, kpi_definition: [{ code: "NOO" }] }],
      [],
    );
    expect(result.NOO.target).toBe(5);
    expect(result.NOO.hasTarget).toBe(true);
  });

  it("mengabaikan baris target dengan kpi_definition null (definition tidak ditemukan)", () => {
    const result = aggregateGovernedKpis(
      [{ target_value: 5, kpi_definition: null }],
      [],
    );
    expect(result.CALL.hasTarget).toBe(false);
    expect(result.EFFECTIVE_CALL.hasTarget).toBe(false);
  });

  it("CREDITED menambah, REVERSED mengurangi achieved -- per kode KPI, terpisah dari kode lain", () => {
    const result = aggregateGovernedKpis(
      [],
      [
        { kpi_code: "CALL", event_type: "CREDITED", value: 1 },
        { kpi_code: "CALL", event_type: "CREDITED", value: 1 },
        { kpi_code: "CALL", event_type: "REVERSED", value: 1 },
        { kpi_code: "REVENUE", event_type: "CREDITED", value: 900_000 },
      ],
    );
    expect(result.CALL.achieved).toBe(1);
    expect(result.REVENUE.achieved).toBe(900_000);
    expect(result.ORDER_COUNT.achieved).toBe(0);
  });

  it("mengonversi value string (numeric dari Postgres) menjadi number", () => {
    const result = aggregateGovernedKpis(
      [],
      [{ kpi_code: "REVENUE", event_type: "CREDITED", value: "900000" }],
    );
    expect(result.REVENUE.achieved).toBe(900_000);
  });

  it("value null diperlakukan sebagai 0", () => {
    const result = aggregateGovernedKpis(
      [],
      [{ kpi_code: "ORDER_COUNT", event_type: "CREDITED", value: null }],
    );
    expect(result.ORDER_COUNT.achieved).toBe(0);
  });
});
