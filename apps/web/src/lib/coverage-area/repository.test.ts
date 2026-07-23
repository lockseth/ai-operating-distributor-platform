import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryCoverageAreaRepository } from "./repository";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const OWNER_A = "owner-a";
const SALES_A = "sales-a"; // sengaja TIDAK di-seedOwner -- merepresentasikan actor non-owner

describe("CoverageAreaRepository.createArea", () => {
  let repo: InMemoryCoverageAreaRepository;

  beforeEach(() => {
    repo = new InMemoryCoverageAreaRepository();
    repo.seedOwner(COMPANY_A, OWNER_A);
  });

  it("Owner melihat wilayah aktif tenant setelah dibuat", async () => {
    await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Cirebon Timur", description: null });
    expect(repo.getAreas(COMPANY_A)).toEqual(["Cirebon Timur"]);
  });

  it("empty state: tenant baru belum memiliki wilayah", () => {
    expect(repo.getAreas(COMPANY_A)).toEqual([]);
  });

  it("Owner dapat membuat wilayah baru dari form", async () => {
    const result = await repo.createArea({
      companyId: COMPANY_A,
      actorId: OWNER_A,
      name: "Cirebon Kota",
      description: "Area pusat kota",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.areas).toContain("Cirebon Kota");
    }
  });

  it("wilayah baru otomatis masuk daftar (dipakai UI untuk auto-select)", async () => {
    repo.setAreas(COMPANY_A, ["Cirebon Timur"]);
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Cirebon Barat", description: null });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.areas).toEqual(["Cirebon Timur", "Cirebon Barat"]);
    }
  });

  it("submit tanpa nama (kosong/whitespace) ditolak", async () => {
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "   ", description: null });
    expect(result.outcome).toBe("invalid_name");
  });

  it("duplicate wilayah case-insensitive ditolak", async () => {
    repo.setAreas(COMPANY_A, ["Cirebon Timur"]);
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "cirebon timur", description: null });
    expect(result.outcome).toBe("duplicate_area");
    expect(repo.getAreas(COMPANY_A)).toEqual(["Cirebon Timur"]);
  });

  it("duplicate wilayah dengan whitespace berbeda tetap ditolak", async () => {
    repo.setAreas(COMPANY_A, ["Cirebon Timur"]);
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "  Cirebon Timur  ", description: null });
    expect(result.outcome).toBe("duplicate_area");
  });

  it("wilayah tenant lain tidak bocor / tidak dianggap duplicate di tenant ini", async () => {
    repo.seedOwner(COMPANY_B, "owner-b");
    repo.setAreas(COMPANY_B, ["Bandung Utara"]);
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Bandung Utara", description: null });
    expect(result.outcome).toBe("created");
    expect(repo.getAreas(COMPANY_A)).toEqual(["Bandung Utara"]);
    expect(repo.getAreas(COMPANY_B)).toEqual(["Bandung Utara"]);
  });

  it("SALES (actor non-owner) tidak dapat membuat wilayah", async () => {
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: SALES_A, name: "Cirebon Timur", description: null });
    expect(result.outcome).toBe("forbidden");
    expect(repo.getAreas(COMPANY_A)).toEqual([]);
  });

  it("actor owner tenant lain tidak berwenang membuat wilayah company A", async () => {
    repo.seedOwner(COMPANY_B, "owner-b");
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: "owner-b", name: "Cirebon Timur", description: null });
    expect(result.outcome).toBe("forbidden");
  });

  it("assignment tidak menghapus/menimpa wilayah yang sudah ada -- hanya append", async () => {
    repo.setAreas(COMPANY_A, ["Cirebon Timur", "Cirebon Kota"]);
    await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Cirebon Barat", description: null });
    expect(repo.getAreas(COMPANY_A)).toEqual(["Cirebon Timur", "Cirebon Kota", "Cirebon Barat"]);
  });
});
