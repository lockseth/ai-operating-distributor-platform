import { describe, it, expect } from "vitest";
import { isBucketBackedEvidence } from "./evidence-urls";

describe("isBucketBackedEvidence", () => {
  it("foto/tanda tangan di folder company sendiri", () => {
    expect(isBucketBackedEvidence({ evidenceType: "photo", storageRef: "c1/d1/a.jpg" }, "c1")).toBe(true);
    expect(isBucketBackedEvidence({ evidenceType: "signature", storageRef: "c1/d1/a.png" }, "c1")).toBe(true);
  });
  it("menolak tenant lain, traversal, tipe lokasi, dan file id Telegram", () => {
    expect(isBucketBackedEvidence({ evidenceType: "photo", storageRef: "c2/d1/a.jpg" }, "c1")).toBe(false);
    expect(isBucketBackedEvidence({ evidenceType: "photo", storageRef: "c1/../c2/a.jpg" }, "c1")).toBe(false);
    expect(isBucketBackedEvidence({ evidenceType: "location", storageRef: "geo:-6.1,108.2" }, "c1")).toBe(false);
    expect(isBucketBackedEvidence({ evidenceType: "photo", storageRef: "AgACAgUAAxkBAAI" }, "c1")).toBe(false);
  });
});
