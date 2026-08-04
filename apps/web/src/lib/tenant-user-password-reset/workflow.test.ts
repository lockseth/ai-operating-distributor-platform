import { describe, expect, it } from "vitest";
import { resetTenantUserPassword } from "./workflow";
import { InMemoryTenantUserPasswordResetRepository } from "./repository";

// isValidTargetUserId() (service.ts) hanya menerima bentuk UUID -- fixture
// target di bawah SENGAJA UUID sungguhan (bukan "target-owner" dsb) supaya
// tidak tertahan di penyaring format sebelum sempat menyentuh repository.
// actorId TIDAK divalidasi bentuknya (hanya targetUserId), jadi actor id
// tetap boleh string bebas.
const SUPER_ADMIN_ID = "actor-super-admin";
const OWNER_ID = "20000000-0000-0000-0000-000000000001";
const ADMIN_ID = "20000000-0000-0000-0000-000000000002";
const SALES_ID = "20000000-0000-0000-0000-000000000003";
const COMPANY_ID = "company-1";

function seedActiveSuperAdmin(repo: InMemoryTenantUserPasswordResetRepository, id = SUPER_ADMIN_ID) {
  repo.seedUser({ id, companyId: COMPANY_ID, email: "operator@aodp.local", isActive: true, roles: ["super_admin"] });
}

describe("resetTenantUserPassword (Gate 3E-D2-A-R1)", () => {
  it("1. active super_admin berhasil mereset password target aktif", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("reset");
    if (result.outcome === "reset") {
      expect(result.tempPassword.length).toBeGreaterThan(16);
      expect(result.targetEmail).toBe("owner@tenant.test");
    }
  });

  it("2. owner, admin, dan sales masing-masing boleh jadi target", async () => {
    for (const [targetId, role] of [[OWNER_ID, "owner"], [ADMIN_ID, "admin"], [SALES_ID, "sales"]] as const) {
      const repo = new InMemoryTenantUserPasswordResetRepository();
      seedActiveSuperAdmin(repo);
      repo.seedUser({ id: targetId, companyId: COMPANY_ID, email: `${role}@tenant.test`, isActive: true, roles: [role] });

      const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: targetId });
      expect(result.outcome).toBe("reset");
    }
  });

  it("3. actor bukan super_admin ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    repo.seedUser({ id: "actor-owner", companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner2@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: "actor-owner", targetUserId: OWNER_ID });
    expect(result.outcome).toBe("forbidden");
    expect(repo.authUpdateCallCount).toBe(0);
  });

  it("4a. actor super_admin tidak aktif ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    repo.seedUser({ id: SUPER_ADMIN_ID, companyId: COMPANY_ID, email: "operator@aodp.local", isActive: false, roles: ["super_admin"] });
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(result.outcome).toBe("forbidden");
  });

  it("4b. target tidak aktif ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: false, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(result.outcome).toBe("target_inactive");
  });

  it("5. target super_admin ditolak mutlak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    const otherSuperAdminId = "20000000-0000-0000-0000-000000000099";
    repo.seedUser({ id: otherSuperAdminId, companyId: COMPANY_ID, email: "other-operator@aodp.local", isActive: true, roles: ["super_admin"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: otherSuperAdminId });
    expect(result.outcome).toBe("target_forbidden_super_admin");
  });

  it("6a. target tidak ditemukan ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);

    const result = await resetTenantUserPassword(repo, {
      actorId: SUPER_ADMIN_ID,
      targetUserId: "00000000-0000-0000-0000-000000000099",
    });
    expect(result.outcome).toBe("target_not_found");
  });

  it("6b. target UUID tidak valid ditolak sebelum menyentuh repository", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: "not-a-uuid" });
    expect(result.outcome).toBe("target_not_found");
    expect(repo.authUpdateCallCount).toBe(0);
  });

  it("6c. target tanpa auth.users yang valid (profil yatim) ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });
    repo.clearAuthHash(OWNER_ID);

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(result.outcome).toBe("target_auth_missing");
  });

  it("target dengan role di luar allowlist {owner,admin,sales} ditolak", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    const financeTargetId = "20000000-0000-0000-0000-000000000098";
    repo.seedUser({ id: financeTargetId, companyId: COMPANY_ID, email: "finance@tenant.test", isActive: true, roles: ["finance"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: financeTargetId });
    expect(result.outcome).toBe("target_role_not_resettable");
  });

  it("8. temporary password dibuat server-side (CSPRNG), tidak pernah dari input", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(result.outcome).toBe("reset");
    if (result.outcome === "reset") {
      // ~144 bit entropi base64url (identik generateSecureTempPassword())
      expect(result.tempPassword).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
  });

  it("9 & 17. must_change_password FAIL-CLOSED sedini mungkin -- TRUE segera setelah tahap DB pertama, sebelum Auth API dipanggil", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] }, "hash-pre-reset");

    // Panggil beginReset langsung (bukan lewat workflow penuh) untuk
    // membuktikan urutan: flag sudah TRUE sebelum updateAuthPassword() ada
    // kesempatan dipanggil sama sekali -- request lain (sesi lama/stale)
    // yang membaca must_change_password DI ANTARA begin() dan selesainya
    // seluruh reset tetap akan diblokir (mencerminkan get-user.ts yang
    // memeriksa flag ini pada SETIAP request).
    const begin = await repo.beginReset({ operationId: "op-1", actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(begin.ok).toBe(true);
    expect(repo.getMustChangePassword(OWNER_ID)).toBe(true);
    expect(repo.getBaselineHash(OWNER_ID)).toBe("hash-pre-reset");
    expect(repo.authUpdateCallCount).toBe(0);
  });

  it("10. role/company/membership target tidak berubah oleh reset", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: ADMIN_ID, companyId: COMPANY_ID, email: "admin@tenant.test", isActive: true, roles: ["admin"] });

    const before = { ...repo.getUser(ADMIN_ID)! };
    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: ADMIN_ID });
    const after = repo.getUser(ADMIN_ID)!;

    expect(result.outcome).toBe("reset");
    expect(after.companyId).toBe(before.companyId);
    expect(after.roles).toEqual(before.roles);
    expect(after.email).toBe(before.email);
    expect(after.id).toBe(before.id);
  });

  it("11. audit trail tidak pernah menyertakan password/hash", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });
    expect(result.outcome).toBe("reset");
    const tempPassword = result.outcome === "reset" ? result.tempPassword : "";

    const audit = repo.getAuditTrail();
    expect(audit.length).toBeGreaterThan(0);
    for (const entry of audit) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(tempPassword);
      expect(Object.keys(entry)).not.toContain("password");
      expect(Object.keys(entry)).not.toContain("tempPassword");
    }
    expect(audit.map((e) => e.action)).toEqual([
      "tenant_user.password_reset_started",
      "tenant_user.password_reset_completed",
    ]);
  });

  it("12. kegagalan Auth API tidak pernah menghasilkan kredensial, target tetap fail-closed dan bisa pulih dengan password lama", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] }, "hash-old-password");
    repo.failAuthUpdate = true;

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("auth_update_failed");
    expect(result).not.toHaveProperty("tempPassword");
    expect(repo.getMustChangePassword(OWNER_ID)).toBe(true);
    // Password LAMA tidak berubah (Auth mutation gagal) DAN sama dengan
    // baseline -- artinya target masih bisa login dengan password lama lalu
    // diarahkan ke mandatory-change (complete_mandatory_password_change()
    // akan melihat current === baseline -> "belum diganti", bukan lockout
    // permanen tanpa cara pulih).
    expect(repo.getAuthHash(OWNER_ID)).toBe("hash-old-password");
    expect(repo.getBaselineHash(OWNER_ID)).toBe("hash-old-password");
    expect(repo.getAuditTrail().map((e) => e.action)).toEqual([
      "tenant_user.password_reset_started",
      "tenant_user.password_reset_failed",
    ]);
  });

  it("13. kegagalan tahap database (actor forbidden) mencegah Auth API dipanggil sama sekali", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    repo.seedUser({ id: "actor-admin", companyId: COMPANY_ID, email: "admin@tenant.test", isActive: true, roles: ["admin"] });
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const result = await resetTenantUserPassword(repo, { actorId: "actor-admin", targetUserId: OWNER_ID });

    expect(result.outcome).toBe("forbidden");
    expect(repo.authUpdateCallCount).toBe(0);
    expect(repo.getMustChangePassword(OWNER_ID)).toBe(false);
  });

  it("14. submit ganda (konkuren) pada target yang sama -- hanya satu yang sukses, sisanya already_in_progress", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });

    const [first, second] = await Promise.all([
      resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID }),
      resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID }),
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already_in_progress", "reset"]);
  });

  it("15. tempPassword tidak pernah masuk console.log/error di workflow atau actions", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const workflowSrc = readFileSync(path.resolve(dir, "workflow.ts"), "utf8");
    const actionsSrc = readFileSync(path.resolve(dir, "actions.ts"), "utf8");
    expect(workflowSrc).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
    expect(actionsSrc).not.toMatch(/console\.(log|error|warn)\([^)]*tempPassword/);
  });

  it("kegagalan finalize yang habis retry TIDAK PERNAH mengembalikan tempPassword, meski Auth sudah sukses", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });
    repo.finalizeFailuresRemaining = 10; // lebih besar dari MAX_FINALIZE_ATTEMPTS internal workflow

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("unexpected_error");
    expect(result).not.toHaveProperty("tempPassword");
    expect(repo.authUpdateCallCount).toBe(1); // Auth API TIDAK diulang, hanya finalize yang di-retry
    expect(repo.getAuditTrail().map((e) => e.action)).toEqual([
      "tenant_user.password_reset_started",
      "tenant_user.password_reset_failed",
    ]);
  });

  it("finalize yang gagal 1x lalu sukses pada retry berikutnya tetap mengembalikan reset", async () => {
    const repo = new InMemoryTenantUserPasswordResetRepository();
    seedActiveSuperAdmin(repo);
    repo.seedUser({ id: OWNER_ID, companyId: COMPANY_ID, email: "owner@tenant.test", isActive: true, roles: ["owner"] });
    repo.finalizeFailuresRemaining = 1;

    const result = await resetTenantUserPassword(repo, { actorId: SUPER_ADMIN_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("reset");
    expect(repo.finalizeCallCount).toBe(2);
  });
});
