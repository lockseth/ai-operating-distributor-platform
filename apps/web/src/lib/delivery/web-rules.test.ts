import { describe, it, expect } from "vitest";
import { buildArrivalLocationEvidence, buildItemOutcomes, canOperateDelivery, isEvidencePathForDelivery, isValidGeoFix, nextDeliveryStep } from "./web-rules";

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

describe("buildItemOutcomes", () => {
  const items = [{ id: "a", dispatchedQuantity: 10 }, { id: "b", dispatchedQuantity: 4 }];
  it("full: semua diterima", () => {
    const r = buildItemOutcomes("full", items, {});
    expect(r).toEqual({ ok: true, outcomes: { a: { receivedQuantity: 10, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 }, b: { receivedQuantity: 4, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 } } });
  });
  it("rejected: semua ditolak; store_closed/failed: semua unresolved", () => {
    const rej = buildItemOutcomes("rejected", items, {});
    expect(rej.ok && rej.outcomes.a).toMatchObject({ receivedQuantity: 0, rejectedQuantity: 10 });
    const closed = buildItemOutcomes("store_closed", items, {});
    expect(closed.ok && closed.outcomes.b).toMatchObject({ receivedQuantity: 0, unresolvedQuantity: 4 });
  });
  it("partial: sisanya unresolved", () => {
    const r = buildItemOutcomes("partial", items, { a: 6, b: 4 });
    expect(r.ok && r.outcomes.a).toMatchObject({ receivedQuantity: 6, unresolvedQuantity: 4 });
  });
  it("partial menolak: nol diterima, semua diterima, melebihi dikirim, atau tidak diisi", () => {
    expect(buildItemOutcomes("partial", items, { a: 0, b: 0 }).ok).toBe(false);
    expect(buildItemOutcomes("partial", items, { a: 10, b: 4 }).ok).toBe(false);
    expect(buildItemOutcomes("partial", items, { a: 11, b: 1 }).ok).toBe(false);
    expect(buildItemOutcomes("partial", items, { a: 5 }).ok).toBe(false);
  });
});

describe("isEvidencePathForDelivery", () => {
  it("hanya path di folder company/delivery yang sama", () => {
    expect(isEvidencePathForDelivery("c1/d1/x.jpg", "c1", "d1")).toBe(true);
    expect(isEvidencePathForDelivery("c1/d2/x.jpg", "c1", "d1")).toBe(false);
    expect(isEvidencePathForDelivery("c2/d1/x.jpg", "c1", "d1")).toBe(false);
    expect(isEvidencePathForDelivery("c1/d1/../d2/x.jpg", "c1", "d1")).toBe(false);
  });
});
