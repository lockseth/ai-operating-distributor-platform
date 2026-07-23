import { describe, expect, it } from "vitest";
import { validateCoverageAreaName } from "./service";

describe("validateCoverageAreaName", () => {
  it("nama kosong ditolak", () => {
    expect(validateCoverageAreaName("")).not.toBeNull();
    expect(validateCoverageAreaName("   ")).not.toBeNull();
  });

  it("nama valid diterima", () => {
    expect(validateCoverageAreaName("Cirebon Timur")).toBeNull();
  });

  it("nama lebih dari 100 karakter ditolak", () => {
    expect(validateCoverageAreaName("A".repeat(101))).not.toBeNull();
  });

  it("nama tepat 100 karakter diterima", () => {
    expect(validateCoverageAreaName("A".repeat(100))).toBeNull();
  });
});
