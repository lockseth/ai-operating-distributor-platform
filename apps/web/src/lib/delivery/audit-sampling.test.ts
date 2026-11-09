import { describe, expect, it } from "vitest";
import { classifyCandidate, selectAuditSample, type AuditCandidate } from "./audit-sampling";

const c = (id: string, o: Partial<AuditCandidate> = {}): AuditCandidate => ({
  deliveryId: id, inputByAdmin: false, hasLocation: true, hasVariance: false, ...o,
});

describe("selectAuditSample", () => {
  it("mengklasifikasi dengan urutan prioritas", () => {
    expect(classifyCandidate(c("a", { inputByAdmin: true, hasLocation: false }))).toBe("admin_input");
    expect(classifyCandidate(c("a", { hasLocation: false, hasVariance: true }))).toBe("no_location");
    expect(classifyCandidate(c("a", { hasVariance: true }))).toBe("variance");
    expect(classifyCandidate(c("a"))).toBe("random");
  });

  it("mendahulukan prioritas sebelum acak", () => {
    const list = [c("r1"), c("r2"), c("adm", { inputByAdmin: true }), c("nl", { hasLocation: false }), c("v", { hasVariance: true })];
    const picked = selectAuditSample(list, 3, () => 0.5);
    expect(picked.map((p) => p.deliveryId).sort()).toEqual(["adm", "nl", "v"]);
  });

  it("mengisi sisa slot dengan acak, tanpa duplikat, maksimal sebanyak kandidat", () => {
    const list = [c("adm", { inputByAdmin: true }), c("r1"), c("r2")];
    const picked = selectAuditSample(list, 10, () => 0.1);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((p) => p.deliveryId)).size).toBe(3);
    expect(picked[0]).toEqual({ deliveryId: "adm", reason: "admin_input" });
  });

  it("jumlah 0 atau tanpa kandidat menghasilkan kosong", () => {
    expect(selectAuditSample([c("a")], 0)).toEqual([]);
    expect(selectAuditSample([], 5)).toEqual([]);
  });
});
