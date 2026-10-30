import { describe, it, expect } from "vitest";
import { buildArrivalLocationEvidence, canOperateDelivery, isValidGeoFix, nextDeliveryStep } from "./web-rules";

describe("nextDeliveryStep", () => {
  it("memetakan status ke langkah pengantar", () => {
    expect(nextDeliveryStep("planned")).toBe("start");
    expect(nextDeliveryStep("dispatched")).toBe("arrive");
    expect(nextDeliveryStep("arrived")).toBe("record_result");
    expect(nextDeliveryStep("fully_received")).toBe("done");
    expect(nextDeliveryStep("verified")).toBe("done");
  });
});

describe("canOperateDelivery", () => {
  it("hanya pengantar yang ditugaskan", () => {
    expect(canOperateDelivery("u1", { assignedDriverId: "u1" })).toBe(true);
    expect(canOperateDelivery("u2", { assignedDriverId: "u1" })).toBe(false);
    expect(canOperateDelivery("u1", { assignedDriverId: null })).toBe(false);
  });
});

describe("buildArrivalLocationEvidence", () => {
  it("lokasi valid menjadi bukti location", () => {
    const r = buildArrivalLocationEvidence({ latitude: -6.7063, longitude: 108.557, accuracy: 12 }, "2026-10-30T01:00:00Z");
    expect(r.locationMissing).toBe(false);
    expect(r.evidence).toMatchObject({ evidenceType: "location", latitude: -6.7063, longitude: 108.557, storageRef: "geo:-6.706300,108.557000" });
  });
  it("tanpa lokasi tidak memblokir tetapi ditandai", () => {
    expect(buildArrivalLocationEvidence(null, "x")).toEqual({ evidence: null, locationMissing: true });
  });
  it("koordinat di luar jangkauan atau NaN dianggap tanpa lokasi", () => {
    expect(isValidGeoFix({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidGeoFix({ latitude: 0, longitude: 181 })).toBe(false);
    expect(isValidGeoFix({ latitude: Number.NaN, longitude: 0 })).toBe(false);
  });
});
