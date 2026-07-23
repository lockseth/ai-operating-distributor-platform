import { describe, it, expect, beforeEach } from "vitest";
import { createSalesman } from "./workflow";
import { InMemorySalesmanRepository } from "./repository";
import type { CreateSalesmanInput } from "./types";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const ACTOR_A = "actor-a-owner";
const ACTOR_B = "actor-b-owner";

const AREAS_A = ["Cirebon Timur", "Cirebon Kota", "Cirebon Barat"];

function baseInput(overrides: Partial<CreateSalesmanInput> = {}): CreateSalesmanInput {
  return {
    companyId: COMPANY_A,
    actorId: ACTOR_A,
    fullName: "Budi Santoso",
    email: "budi.santoso@waluyo.test",
    phone: "0812-3456-7890",
    tempPassword: "Passw0rd123",
    areaIds: ["Cirebon Timur"],
    ...overrides,
  };
}

function repoWithAreas(companyId = COMPANY_A, areas = AREAS_A): InMemorySalesmanRepository {
  const repo = new InMemorySalesmanRepository();
  repo.setTenantCoverageAreas(companyId, areas);
  // Actor pembuat salesman diasumsikan SUDAH owner tenant tsb -- otorisasi
  // sesungguhnya diperiksa di actions.ts (canManageSalesman) sebelum
  // workflow.ts dipanggil; seed di sini mencerminkan prasyarat itu supaya
  // assignCoverageAreas (yang independen memeriksa ulang actor) konsisten
  // dengan RPC Postgres sungguhan.
  repo.seedActorRole(companyId === COMPANY_B ? ACTOR_B : ACTOR_A, companyId, "owner");
  return repo;
}

describe("createSalesman — happy path", () => {
  let repo: InMemorySalesmanRepository;
  beforeEach(() => {
    repo = repoWithAreas();
  });

  it("admin berwenang berhasil membuat salesman", async () => {
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      const row = repo.getUser(result.userId);
      expect(row?.email).toBe("budi.santoso@waluyo.test");
      expect(row?.companyId).toBe(COMPANY_A);
    }
  });

  it("role yang di-assign selalu 'sales' (role_id dari findSalesRoleId, bukan parameter bebas)", async () => {
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      const roles = repo.getRolesFor(result.userId);
      expect(roles).toHaveLength(1);
      expect(roles[0].roleId).toBe(repo.salesRoleId);
    }
  });
});

describe("createSalesman — tenant isolation", () => {
  it("company_id hasil selalu persis dari input server-side, tidak pernah berubah/di-manipulasi", async () => {
    const repo = repoWithAreas();
    const result = await createSalesman(repo, baseInput({ companyId: COMPANY_A }));
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(repo.getUser(result.userId)?.companyId).toBe(COMPANY_A);
      expect(repo.getRolesFor(result.userId)[0].companyId).toBe(COMPANY_A);
    }
  });

  it("cross-tenant: salesman company A tidak pernah tercatat pada company B", async () => {
    const repo = repoWithAreas();
    repo.setTenantCoverageAreas(COMPANY_B, ["Bandung Utara"]);
    repo.seedActorRole(ACTOR_B, COMPANY_B, "owner");
    const resultA = await createSalesman(
      repo,
      baseInput({ companyId: COMPANY_A, email: "a@waluyo.test" })
    );
    const resultB = await createSalesman(
      repo,
      baseInput({
        companyId: COMPANY_B,
        actorId: ACTOR_B,
        email: "b@waluyo.test",
        areaIds: ["Bandung Utara"],
      })
    );
    expect(resultA.outcome).toBe("created");
    expect(resultB.outcome).toBe("created");
    if (resultA.outcome === "created" && resultB.outcome === "created") {
      expect(repo.getUser(resultA.userId)?.companyId).toBe(COMPANY_A);
      expect(repo.getUser(resultB.userId)?.companyId).toBe(COMPANY_B);
      expect(repo.getUser(resultA.userId)?.companyId).not.toBe(
        repo.getUser(resultB.userId)?.companyId
      );
    }
  });
});

describe("createSalesman — validasi & duplicate", () => {
  let repo: InMemorySalesmanRepository;
  beforeEach(() => {
    repo = repoWithAreas();
  });

  it("input tidak valid (nama kosong) ditolak sebelum menyentuh repository", async () => {
    const result = await createSalesman(repo, baseInput({ fullName: "" }));
    expect(result.outcome).toBe("invalid_input");
    expect(repo.totalUsers()).toBe(0);
  });

  it("email tidak valid ditolak", async () => {
    const result = await createSalesman(repo, baseInput({ email: "not-an-email" }));
    expect(result.outcome).toBe("invalid_input");
  });

  it("password sementara kurang dari 8 karakter ditolak", async () => {
    const result = await createSalesman(repo, baseInput({ tempPassword: "short" }));
    expect(result.outcome).toBe("invalid_input");
  });

  it("duplicate email ditangani (email sudah terdaftar)", async () => {
    repo.seedExistingEmail("sudah.ada@waluyo.test");
    const result = await createSalesman(repo, baseInput({ email: "sudah.ada@waluyo.test" }));
    expect(result.outcome).toBe("duplicate_email");
    expect(repo.totalUsers()).toBe(0);
  });

  it("role 'sales' tidak ditemukan (migration belum lengkap) ditangani tanpa membuat auth user yatim", async () => {
    repo.roleLookupReturnsNull = true;
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("role_not_found");
    expect(repo.totalUsers()).toBe(0);
  });
});

describe("createSalesman — kegagalan parsial tidak meninggalkan data yatim", () => {
  it("profile insert gagal -> auth user di-rollback (dihapus), tidak ada data tersisa", async () => {
    const repo = repoWithAreas();
    repo.failNextProfileInsert = true;
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("partial_failure_rolled_back");
    expect(repo.totalUsers()).toBe(0);
    expect(repo.hasAnyOrphanRole()).toBe(false);

    // Email tersedia lagi untuk retry -- bukti rollback benar-benar bersih.
    const retry = await createSalesman(repo, baseInput());
    expect(retry.outcome).toBe("created");
  });

  it("role assignment gagal -> auth user + profile di-rollback, tidak ada data tersisa", async () => {
    const repo = repoWithAreas();
    repo.failNextRoleAssign = true;
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("partial_failure_rolled_back");
    expect(repo.totalUsers()).toBe(0);
    expect(repo.hasAnyOrphanRole()).toBe(false);

    const retry = await createSalesman(repo, baseInput());
    expect(retry.outcome).toBe("created");
  });

  it("area tidak valid saat create -> seluruh salesman di-rollback, tidak ada assignment yatim", async () => {
    const repo = repoWithAreas();
    const result = await createSalesman(repo, baseInput({ areaIds: ["Wilayah Tidak Terdaftar"] }));
    expect(result.outcome).toBe("invalid_area");
    expect(repo.totalUsers()).toBe(0);
    expect(repo.hasAnyOrphanRole()).toBe(false);
  });

  it("tenant tanpa konfigurasi coverage area -> create ditolak eksplisit, tidak ada data tersisa", async () => {
    const repo = new InMemorySalesmanRepository(); // sengaja TIDAK diisi setTenantCoverageAreas
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner");
    const result = await createSalesman(repo, baseInput());
    expect(result.outcome).toBe("no_coverage_configured");
    expect(repo.totalUsers()).toBe(0);
  });
});

describe("createSalesman — coverage area saat pembuatan", () => {
  it("assign satu area", async () => {
    const repo = repoWithAreas();
    const result = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Kota"] }));
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(repo.getCoverageAreasFor(COMPANY_A, result.userId)).toEqual(["Cirebon Kota"]);
    }
  });

  it("assign beberapa area sekaligus", async () => {
    const repo = repoWithAreas();
    const result = await createSalesman(
      repo,
      baseInput({ areaIds: ["Cirebon Kota", "Cirebon Barat"] })
    );
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(repo.getCoverageAreasFor(COMPANY_A, result.userId).sort()).toEqual(
        ["Cirebon Barat", "Cirebon Kota"].sort()
      );
    }
  });

  it("tidak ada area dipilih -> ditolak eksplisit (no_areas_provided)", async () => {
    const repo = repoWithAreas();
    const result = await createSalesman(repo, baseInput({ areaIds: [] }));
    expect(result.outcome).toBe("no_areas_provided");
    expect(repo.totalUsers()).toBe(0);
  });
});

describe("assignCoverageAreas — standalone (ubah assignment salesman existing)", () => {
  it("cross-tenant assignment ditolak: actor tenant B tidak bisa menetapkan area salesman tenant A", async () => {
    const repo = repoWithAreas(COMPANY_A, AREAS_A);
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    repo.seedActorRole(ACTOR_B, COMPANY_B, "owner");
    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_B, // actor B mencoba lewat company_id miliknya sendiri
      userId: created.userId, // tapi target adalah salesman company A
      areaIds: ["Cirebon Kota"],
      actorId: ACTOR_B,
    });
    expect(result.outcome).toBe("not_eligible");
    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Timur"]);
  });

  it("actor tanpa wewenang (random id, tidak terdaftar sama sekali) ditolak", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Cirebon Kota"],
      actorId: "random-unauthorized-id",
    });
    expect(result.outcome).toBe("forbidden");
  });

  describe("Owner Control Plane (corrective closure): hanya role 'owner' yang berwenang mengubah wilayah", () => {
    it("owner tenant sendiri berhasil mengubah wilayah Salesman-nya", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Timur"] }));
      if (created.outcome !== "created") throw new Error("setup failed");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: ACTOR_A, // seeded sebagai "owner" oleh repoWithAreas()
      });
      expect(result.outcome).toBe("assigned");
      expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Kota"]);
    });

    it("sales ditolak (direct call, bukan lewat UI)", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput());
      if (created.outcome !== "created") throw new Error("setup failed");
      repo.seedActorRole("actor-sales", COMPANY_A, "sales");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: "actor-sales",
      });
      expect(result.outcome).toBe("forbidden");
    });

    it("manager ditolak (direct call, bukan lewat UI) -- MANAGE_ROLES lama tidak lagi berlaku", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput());
      if (created.outcome !== "created") throw new Error("setup failed");
      repo.seedActorRole("actor-manager", COMPANY_A, "manager");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: "actor-manager",
      });
      expect(result.outcome).toBe("forbidden");
      expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Timur"]);
    });

    it("admin ditolak (direct call, bukan lewat UI)", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput());
      if (created.outcome !== "created") throw new Error("setup failed");
      repo.seedActorRole("actor-admin", COMPANY_A, "admin");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: "actor-admin",
      });
      expect(result.outcome).toBe("forbidden");
    });

    it("super_admin ditolak (direct call, bukan lewat UI)", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput());
      if (created.outcome !== "created") throw new Error("setup failed");
      repo.seedActorRole("actor-super-admin", COMPANY_A, "super_admin");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: "actor-super-admin",
      });
      expect(result.outcome).toBe("forbidden");
    });

    it("owner tenant lain ditolak mengubah wilayah salesman tenant ini", async () => {
      const repo = repoWithAreas();
      const created = await createSalesman(repo, baseInput());
      if (created.outcome !== "created") throw new Error("setup failed");
      repo.seedActorRole("owner-tenant-b", COMPANY_B, "owner");

      const result = await repo.assignCoverageAreas({
        companyId: COMPANY_A,
        userId: created.userId,
        areaIds: ["Cirebon Kota"],
        actorId: "owner-tenant-b",
      });
      expect(result.outcome).toBe("forbidden");
    });
  });

  it("target non-sales (mis. owner) ditolak", async () => {
    const repo = repoWithAreas();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner");

    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: ACTOR_A, // target adalah owner, bukan salesman
      areaIds: ["Cirebon Kota"],
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("not_eligible");
  });

  it("area tidak valid (di luar konfigurasi tenant) ditolak", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Jakarta Pusat"],
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("invalid_area");
    // Assignment lama tidak berubah karena validasi gagal sebelum replace.
    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Timur"]);
  });

  it("duplicate area dalam satu submit ditangani (idempotent, tidak duplikat baris)", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Cirebon Kota", "Cirebon Kota", "Cirebon Barat"],
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("assigned");
    if (result.outcome === "assigned") expect(result.assignedCount).toBe(2);
    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId).sort()).toEqual(
      ["Cirebon Barat", "Cirebon Kota"].sort()
    );
  });

  it("memanggil ulang dengan wilayah yang sama bersifat idempotent (replace, bukan tambah)", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Timur"] }));
    if (created.outcome !== "created") throw new Error("setup failed");

    await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Cirebon Timur"],
      actorId: ACTOR_A,
    });
    await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Cirebon Timur"],
      actorId: ACTOR_A,
    });
    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Timur"]);
  });

  it("audit tercatat untuk perubahan assignment", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Timur"] }));
    if (created.outcome !== "created") throw new Error("setup failed");

    await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: created.userId,
      areaIds: ["Cirebon Kota"],
      actorId: ACTOR_A,
    });

    const audit = repo.getAuditTrail();
    const matching = audit.filter(
      (e) => e.action === "salesman.coverage_area_updated" && e.entityId === created.userId
    );
    // Dua event: satu dari createSalesman (assign awal), satu dari update di atas.
    expect(matching.length).toBeGreaterThanOrEqual(2);
    const event = matching.at(-1);
    expect(event?.actorId).toBe(ACTOR_A);
    expect(event?.companyId).toBe(COMPANY_A);
    expect((event?.newData as { areas: string[] }).areas).toEqual(["Cirebon Kota"]);
    expect((event?.oldData as { areas: string[] }).areas).toEqual(["Cirebon Timur"]);
  });

  it("tenant tanpa konfigurasi coverage area ditangani eksplisit (no_coverage_configured)", async () => {
    const repo = new InMemorySalesmanRepository();
    repo.setTenantCoverageAreas(COMPANY_A, []); // eksplisit kosong, bukan undefined
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner");
    // Buat salesman tanpa lewat createSalesman (yang akan gagal karena no_coverage_configured) --
    // simulasikan salesman sudah ada dari sebelum tenant kehilangan konfigurasi wilayahnya.
    const authResult = await repo.createAuthUser({
      email: "y@waluyo.test",
      password: "Passw0rd123",
      fullName: "Y",
    });
    if (!authResult.ok) throw new Error("setup failed");
    await repo.insertProfile({
      userId: authResult.userId,
      companyId: COMPANY_A,
      email: "y@waluyo.test",
      fullName: "Y",
      phone: null,
    });
    await repo.assignSalesRole({
      userId: authResult.userId,
      roleId: repo.salesRoleId,
      companyId: COMPANY_A,
      assignedBy: ACTOR_A,
    });

    const result = await repo.assignCoverageAreas({
      companyId: COMPANY_A,
      userId: authResult.userId,
      areaIds: ["Cirebon Timur"],
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("no_coverage_configured");
  });
});

describe("setActiveStatus — Gate 1B (aktivasi/deaktivasi Salesman)", () => {
  it("owner tenant sendiri berhasil menonaktifkan Salesman aktif", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    const result = await repo.setActiveStatus({
      companyId: COMPANY_A,
      userId: created.userId,
      active: false,
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("deactivated");
    expect(repo.getUser(created.userId)?.isActive).toBe(false);
  });

  it("owner tenant sendiri berhasil mengaktifkan kembali Salesman nonaktif", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");
    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });

    const result = await repo.setActiveStatus({
      companyId: COMPANY_A,
      userId: created.userId,
      active: true,
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("activated");
    expect(repo.getUser(created.userId)?.isActive).toBe(true);
  });

  it("request berulang terhadap status yang sama bersifat idempotent (unchanged), tidak menghasilkan audit ganda", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    const first = await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });
    const second = await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });
    expect(first.outcome).toBe("deactivated");
    expect(second.outcome).toBe("unchanged");

    const audit = repo.getAuditTrail().filter((e) => e.entityId === created.userId && e.action === "salesman.deactivated");
    expect(audit.length).toBe(1);
  });

  it("sales tidak dapat mengubah status dirinya sendiri (bukan owner)", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");
    repo.seedActorRole(created.userId, COMPANY_A, "sales");

    const result = await repo.setActiveStatus({
      companyId: COMPANY_A,
      userId: created.userId,
      active: false,
      actorId: created.userId,
    });
    expect(result.outcome).toBe("forbidden");
    expect(repo.getUser(created.userId)?.isActive).toBe(true);
  });

  it("manager/admin/super_admin legacy ditolak (bukan owner)", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");
    for (const legacyRole of ["manager", "admin", "super_admin"]) {
      const actorId = `actor-${legacyRole}`;
      repo.seedActorRole(actorId, COMPANY_A, legacyRole);
      const result = await repo.setActiveStatus({
        companyId: COMPANY_A,
        userId: created.userId,
        active: false,
        actorId,
      });
      expect(result.outcome).toBe("forbidden");
    }
    expect(repo.getUser(created.userId)?.isActive).toBe(true);
  });

  it("owner tenant lain (tenant B) ditolak mengubah status Salesman tenant A", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");
    repo.seedActorRole("owner-tenant-b", COMPANY_B, "owner");

    const result = await repo.setActiveStatus({
      companyId: COMPANY_B,
      userId: created.userId,
      active: false,
      actorId: "owner-tenant-b",
    });
    expect(result.outcome).toBe("not_found");
    expect(repo.getUser(created.userId)?.isActive).toBe(true);
  });

  it("target non-Salesman (mis. owner) ditolak", async () => {
    const repo = repoWithAreas();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner");

    const result = await repo.setActiveStatus({
      companyId: COMPANY_A,
      userId: ACTOR_A, // ACTOR_A tidak punya baris `users`, hanya actorRoles
      active: false,
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("not_found");
  });

  it("target tidak ditemukan ditolak", async () => {
    const repo = repoWithAreas();
    const result = await repo.setActiveStatus({
      companyId: COMPANY_A,
      userId: "does-not-exist",
      active: false,
      actorId: ACTOR_A,
    });
    expect(result.outcome).toBe("not_found");
  });

  it("deaktivasi tidak menghapus coverage, role, atau data profil lain", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Timur", "Cirebon Kota"] }));
    if (created.outcome !== "created") throw new Error("setup failed");

    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });

    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId).sort()).toEqual(["Cirebon Kota", "Cirebon Timur"]);
    expect(repo.getRolesFor(created.userId)).toHaveLength(1);
    expect(repo.getUser(created.userId)?.email).toBe("budi.santoso@waluyo.test");
  });

  it("aktivasi kembali tidak membuat user baru dan tidak mengubah coverage existing", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput({ areaIds: ["Cirebon Barat"] }));
    if (created.outcome !== "created") throw new Error("setup failed");

    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });
    const totalBefore = repo.totalUsers();
    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: true, actorId: ACTOR_A });

    expect(repo.totalUsers()).toBe(totalBefore);
    expect(repo.getCoverageAreasFor(COMPANY_A, created.userId)).toEqual(["Cirebon Barat"]);
  });

  it("audit mencatat transisi aktif->nonaktif dan nonaktif->aktif dengan actor dan old/new data", async () => {
    const repo = repoWithAreas();
    const created = await createSalesman(repo, baseInput());
    if (created.outcome !== "created") throw new Error("setup failed");

    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: false, actorId: ACTOR_A });
    await repo.setActiveStatus({ companyId: COMPANY_A, userId: created.userId, active: true, actorId: ACTOR_A });

    const audit = repo.getAuditTrail().filter((e) => e.entityId === created.userId);
    const deactivated = audit.find((e) => e.action === "salesman.deactivated");
    const activated = audit.find((e) => e.action === "salesman.activated");
    expect(deactivated?.actorId).toBe(ACTOR_A);
    expect(deactivated?.companyId).toBe(COMPANY_A);
    expect((deactivated?.oldData as { is_active: boolean }).is_active).toBe(true);
    expect((deactivated?.newData as { is_active: boolean }).is_active).toBe(false);
    expect((activated?.oldData as { is_active: boolean }).is_active).toBe(false);
    expect((activated?.newData as { is_active: boolean }).is_active).toBe(true);
  });
});
