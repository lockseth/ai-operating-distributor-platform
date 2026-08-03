import { describe, it, expect, beforeEach } from "vitest";
import { createTenantUser } from "./workflow";
import { InMemoryTenantUserRepository } from "./repository";
import type { CreateTenantUserInput } from "./types";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const ACTOR_A = "actor-a-owner";
const ACTOR_B = "actor-b-owner";

function baseInput(overrides: Partial<CreateTenantUserInput> = {}): CreateTenantUserInput {
  return {
    companyId: COMPANY_A,
    actorId: ACTOR_A,
    fullName: "Sri Wulandari",
    email: "sri.wulandari@waluyo.test",
    phone: "0812-3456-7890",
    role: "admin",
    ...overrides,
  };
}

function repoAsOwner(companyId = COMPANY_A, actorId = ACTOR_A): InMemoryTenantUserRepository {
  const repo = new InMemoryTenantUserRepository();
  repo.seedActorRole(actorId, companyId, "owner");
  return repo;
}

describe("createTenantUser — happy path", () => {
  let repo: InMemoryTenantUserRepository;
  beforeEach(() => {
    repo = repoAsOwner();
  });

  it("owner berhasil membuat user role admin", async () => {
    const result = await createTenantUser(repo, baseInput({ role: "admin" }));
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      const row = repo.getUser(result.userId);
      expect(row?.email).toBe("sri.wulandari@waluyo.test");
      expect(row?.companyId).toBe(COMPANY_A);
      expect(row?.mustChangePassword).toBe(true);
      expect(repo.getRolesFor(result.userId)[0].roleName).toBe("admin");
    }
  });

  it("owner berhasil membuat user role sales", async () => {
    const result = await createTenantUser(repo, baseInput({ role: "sales", email: "budi@waluyo.test" }));
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(repo.getRolesFor(result.userId)[0].roleName).toBe("sales");
    }
  });

  it("temporary password dibuat server-side (bukan input) dan dikembalikan tepat sekali pada outcome created", async () => {
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(typeof result.tempPassword).toBe("string");
      expect(result.tempPassword.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("dua panggilan berbeda menghasilkan temporary password yang berbeda (bukan konstanta)", async () => {
    const r1 = await createTenantUser(repo, baseInput({ email: "a@waluyo.test" }));
    const r2 = await createTenantUser(repo, baseInput({ email: "b@waluyo.test" }));
    if (r1.outcome !== "created" || r2.outcome !== "created") throw new Error("setup failed");
    expect(r1.tempPassword).not.toBe(r2.tempPassword);
  });

  it("must_change_password selalu TRUE untuk user baru", async () => {
    const result = await createTenantUser(repo, baseInput());
    if (result.outcome !== "created") throw new Error("setup failed");
    expect(repo.getUser(result.userId)?.mustChangePassword).toBe(true);
  });
});

describe("createTenantUser — role allowlist {admin, sales}", () => {
  it("role 'owner' dipaksakan (bypass layer actions.ts) tetap ditolak sebelum menyentuh repository", async () => {
    const repo = repoAsOwner();
    const result = await createTenantUser(
      repo,
      baseInput({ role: "owner" as unknown as CreateTenantUserInput["role"] })
    );
    expect(result.outcome).toBe("invalid_input");
    expect(repo.totalUsers()).toBe(0);
  });

  it("role 'super_admin' dipaksakan tetap ditolak", async () => {
    const repo = repoAsOwner();
    const result = await createTenantUser(
      repo,
      baseInput({ role: "super_admin" as unknown as CreateTenantUserInput["role"] })
    );
    expect(result.outcome).toBe("invalid_input");
    expect(repo.totalUsers()).toBe(0);
  });

  it("role tidak ditemukan di database (migration belum lengkap) ditangani sebagai invalid_role, tanpa auth user yatim", async () => {
    const repo = repoAsOwner();
    repo.roleLookupReturnsNull = true;
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("invalid_role");
    expect(repo.totalUsers()).toBe(0);
  });
});

describe("createTenantUser — otorisasi actor (re-verifikasi RPC, bukan hanya actions.ts)", () => {
  it("non-owner (admin) ditolak dengan forbidden, auth user di-rollback", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "admin");
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("forbidden");
    expect(repo.totalUsers()).toBe(0);
    expect(repo.hasAnyOrphanRole()).toBe(false);
  });

  it("non-owner (sales) ditolak", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "sales");
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("forbidden");
  });

  it("non-owner (manager) ditolak", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "manager");
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("forbidden");
  });

  it("non-owner (super_admin) ditolak -- super_admin tidak pernah lewat jalur tenant", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "super_admin");
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("forbidden");
  });

  it("owner NONAKTIF (is_active = FALSE) ditolak", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner", false);
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("forbidden");
    expect(repo.totalUsers()).toBe(0);
  });

  it("actor tidak terdaftar sama sekali ditolak", async () => {
    const repo = new InMemoryTenantUserRepository();
    const result = await createTenantUser(repo, baseInput({ actorId: "unknown-actor" }));
    expect(result.outcome).toBe("forbidden");
  });
});

describe("createTenantUser — tenant isolation (cross-tenant)", () => {
  it("owner tenant A tidak dapat membuat user untuk tenant B (company_id actor tidak cocok)", async () => {
    const repo = repoAsOwner(COMPANY_A, ACTOR_A);
    const result = await createTenantUser(
      repo,
      baseInput({ companyId: COMPANY_B, actorId: ACTOR_A })
    );
    expect(result.outcome).toBe("forbidden");
    expect(repo.totalUsers()).toBe(0);
  });

  it("dua owner tenant berbeda masing-masing berhasil membuat user hanya di tenant sendiri", async () => {
    const repo = new InMemoryTenantUserRepository();
    repo.seedActorRole(ACTOR_A, COMPANY_A, "owner");
    repo.seedActorRole(ACTOR_B, COMPANY_B, "owner");

    const resultA = await createTenantUser(repo, baseInput({ email: "a@waluyo.test" }));
    const resultB = await createTenantUser(
      repo,
      baseInput({ companyId: COMPANY_B, actorId: ACTOR_B, email: "b@waluyo.test" })
    );

    expect(resultA.outcome).toBe("created");
    expect(resultB.outcome).toBe("created");
    if (resultA.outcome === "created" && resultB.outcome === "created") {
      expect(repo.getUser(resultA.userId)?.companyId).toBe(COMPANY_A);
      expect(repo.getUser(resultB.userId)?.companyId).toBe(COMPANY_B);
    }
  });
});

describe("createTenantUser — validasi & duplicate", () => {
  let repo: InMemoryTenantUserRepository;
  beforeEach(() => {
    repo = repoAsOwner();
  });

  it("nama kosong ditolak sebelum menyentuh repository", async () => {
    const result = await createTenantUser(repo, baseInput({ fullName: "" }));
    expect(result.outcome).toBe("invalid_input");
    expect(repo.totalUsers()).toBe(0);
  });

  it("email tidak valid ditolak", async () => {
    const result = await createTenantUser(repo, baseInput({ email: "not-an-email" }));
    expect(result.outcome).toBe("invalid_input");
  });

  it("duplicate email ditangani (email sudah terdaftar), zero auth user tersisa", async () => {
    repo.seedExistingEmail("sudah.ada@waluyo.test");
    const result = await createTenantUser(repo, baseInput({ email: "sudah.ada@waluyo.test" }));
    expect(result.outcome).toBe("duplicate_email");
    expect(repo.totalUsers()).toBe(0);
  });

  it("phone opsional -- boleh null", async () => {
    const result = await createTenantUser(repo, baseInput({ phone: null }));
    expect(result.outcome).toBe("created");
  });
});

describe("createTenantUser — kegagalan parsial tidak meninggalkan data yatim", () => {
  it("provisioning RPC gagal unexpected -> auth user di-rollback, retry dengan email sama berhasil", async () => {
    const repo = repoAsOwner();
    repo.failProvisionWithReason = { ok: false, reason: "unexpected", message: "simulated db error" };
    const result = await createTenantUser(repo, baseInput());
    expect(result.outcome).toBe("partial_failure_rolled_back");
    expect(repo.totalUsers()).toBe(0);
    expect(repo.hasAnyOrphanRole()).toBe(false);

    repo.failProvisionWithReason = null;
    const retry = await createTenantUser(repo, baseInput());
    expect(retry.outcome).toBe("created");
  });
});
