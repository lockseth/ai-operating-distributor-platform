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

  it("Owner dapat membuat wilayah baru dari form, hasilnya berstatus aktif dengan id stabil", async () => {
    const result = await repo.createArea({
      companyId: COMPANY_A,
      actorId: OWNER_A,
      name: "Cirebon Kota",
      description: "Area pusat kota",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(result.area.name).toBe("Cirebon Kota");
      expect(result.area.description).toBe("Area pusat kota");
      expect(result.area.isActive).toBe(true);
      expect(result.area.id).toBeTruthy();
    }
  });

  it("wilayah baru otomatis masuk daftar (dipakai UI untuk auto-select)", async () => {
    repo.seedArea(COMPANY_A, "Cirebon Timur");
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Cirebon Barat", description: null });
    expect(result.outcome).toBe("created");
    expect(repo.getAreas(COMPANY_A).sort()).toEqual(["Cirebon Barat", "Cirebon Timur"].sort());
  });

  it("submit tanpa nama (kosong/whitespace) ditolak", async () => {
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "   ", description: null });
    expect(result.outcome).toBe("invalid_name");
  });

  it("duplicate wilayah case-insensitive ditolak", async () => {
    repo.seedArea(COMPANY_A, "Cirebon Timur");
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "cirebon timur", description: null });
    expect(result.outcome).toBe("duplicate_area");
    expect(repo.getAreas(COMPANY_A)).toEqual(["Cirebon Timur"]);
  });

  it("duplicate wilayah dengan whitespace berbeda tetap ditolak", async () => {
    repo.seedArea(COMPANY_A, "Cirebon Timur");
    const result = await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "  Cirebon Timur  ", description: null });
    expect(result.outcome).toBe("duplicate_area");
  });

  it("wilayah tenant lain tidak bocor / tidak dianggap duplicate di tenant ini", async () => {
    repo.seedOwner(COMPANY_B, "owner-b");
    repo.seedArea(COMPANY_B, "Bandung Utara");
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
    repo.seedArea(COMPANY_A, "Cirebon Timur");
    repo.seedArea(COMPANY_A, "Cirebon Kota");
    await repo.createArea({ companyId: COMPANY_A, actorId: OWNER_A, name: "Cirebon Barat", description: null });
    expect(repo.getAreas(COMPANY_A).sort()).toEqual(["Cirebon Barat", "Cirebon Kota", "Cirebon Timur"].sort());
  });
});

describe("CoverageAreaRepository.updateArea", () => {
  let repo: InMemoryCoverageAreaRepository;
  let areaId: string;

  beforeEach(() => {
    repo = new InMemoryCoverageAreaRepository();
    repo.seedOwner(COMPANY_A, OWNER_A);
    areaId = repo.seedArea(COMPANY_A, "Cirebon Timur", { description: "lama" });
  });

  it("Owner dapat mengedit nama dan keterangan", async () => {
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: OWNER_A, areaId, name: "Cirebon Timur Baru", description: "baru",
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome === "updated") {
      expect(result.area.name).toBe("Cirebon Timur Baru");
      expect(result.area.description).toBe("baru");
    }
  });

  it("rename tidak mengubah id (satu master, bukan record baru)", async () => {
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: OWNER_A, areaId, name: "Cirebon Timur Baru", description: null,
    });
    expect(result.outcome).toBe("updated");
    if (result.outcome === "updated") expect(result.area.id).toBe(areaId);
  });

  it("non-owner ditolak", async () => {
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: SALES_A, areaId, name: "X", description: null,
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("wilayah tenant lain ditolak (cross-tenant)", async () => {
    repo.seedOwner(COMPANY_B, "owner-b");
    const result = await repo.updateArea({
      companyId: COMPANY_B, actorId: "owner-b", areaId, name: "X", description: null,
    });
    expect(result.outcome).toBe("not_found");
  });

  it("duplicate nama (case-insensitive) terhadap wilayah lain ditolak", async () => {
    repo.seedArea(COMPANY_A, "Cirebon Kota");
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: OWNER_A, areaId, name: "cirebon kota", description: null,
    });
    expect(result.outcome).toBe("duplicate_area");
  });

  it("rename ke nama yang sama persis (dirinya sendiri) tidak dianggap duplicate", async () => {
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: OWNER_A, areaId, name: "Cirebon Timur", description: "update keterangan saja",
    });
    expect(result.outcome).toBe("updated");
  });

  it("wilayah tidak ditemukan ditolak", async () => {
    const result = await repo.updateArea({
      companyId: COMPANY_A, actorId: OWNER_A, areaId: "does-not-exist", name: "X", description: null,
    });
    expect(result.outcome).toBe("not_found");
  });
});

describe("CoverageAreaRepository.setActiveStatus", () => {
  let repo: InMemoryCoverageAreaRepository;
  let areaId: string;

  beforeEach(() => {
    repo = new InMemoryCoverageAreaRepository();
    repo.seedOwner(COMPANY_A, OWNER_A);
    areaId = repo.seedArea(COMPANY_A, "Cirebon Timur");
  });

  it("Owner dapat menonaktifkan wilayah aktif", async () => {
    const result = await repo.setActiveStatus({ companyId: COMPANY_A, actorId: OWNER_A, areaId, isActive: false });
    expect(result.outcome).toBe("deactivated");
    expect(repo.getArea(areaId)?.isActive).toBe(false);
  });

  it("Owner dapat mengaktifkan kembali wilayah nonaktif", async () => {
    await repo.setActiveStatus({ companyId: COMPANY_A, actorId: OWNER_A, areaId, isActive: false });
    const result = await repo.setActiveStatus({ companyId: COMPANY_A, actorId: OWNER_A, areaId, isActive: true });
    expect(result.outcome).toBe("activated");
    expect(repo.getArea(areaId)?.isActive).toBe(true);
  });

  it("request berulang terhadap status yang sama bersifat idempotent (unchanged)", async () => {
    const result = await repo.setActiveStatus({ companyId: COMPANY_A, actorId: OWNER_A, areaId, isActive: true });
    expect(result.outcome).toBe("unchanged");
  });

  it("non-owner ditolak", async () => {
    const result = await repo.setActiveStatus({ companyId: COMPANY_A, actorId: SALES_A, areaId, isActive: false });
    expect(result.outcome).toBe("forbidden");
    expect(repo.getArea(areaId)?.isActive).toBe(true);
  });

  it("tidak pernah menghapus baris (nonaktif tetap ada di listAreas)", async () => {
    await repo.setActiveStatus({ companyId: COMPANY_A, actorId: OWNER_A, areaId, isActive: false });
    const areas = await repo.listAreas(COMPANY_A);
    expect(areas.find((a) => a.id === areaId)).toBeDefined();
  });

  it("wilayah tenant lain ditolak (cross-tenant)", async () => {
    repo.seedOwner(COMPANY_B, "owner-b");
    const result = await repo.setActiveStatus({ companyId: COMPANY_B, actorId: "owner-b", areaId, isActive: false });
    expect(result.outcome).toBe("not_found");
  });
});
