// Gate 3E-D2-B — resetTenantUserPassword() (lib/tenant-user-password-reset/
// workflow.ts) TIDAK diubah sama sekali; test ini membuktikan repository
// self-service Telegram BARU (backstop: actor harus = target, target harus
// punya telegram pairing aktif) memenuhi kontrak yang sama dan tetap
// fail-closed pada setiap kegagalan.

import { describe, expect, it } from "vitest";
import { resetTenantUserPassword } from "@/lib/tenant-user-password-reset/workflow";
import {
  InMemoryTelegramSelfServicePasswordResetRepository,
  type InMemoryTelegramUserRow,
} from "./repository";

const OWNER_ID = "30000000-0000-0000-0000-000000000001";
const ADMIN_ID = "30000000-0000-0000-0000-000000000002";
const SALES_ID = "30000000-0000-0000-0000-000000000003";
const COMPANY_ID = "company-1";

function seed(
  repo: InMemoryTelegramSelfServicePasswordResetRepository,
  overrides: Partial<InMemoryTelegramUserRow> & { id: string; roles: string[] },
) {
  repo.seedUser({
    companyId: COMPANY_ID,
    email: `${overrides.id}@tenant.test`,
    isActive: true,
    hasActiveTelegramPairing: true,
    ...overrides,
  });
}

describe("resetTenantUserPassword via self-service Telegram repository (Gate 3E-D2-B)", () => {
  it("1. owner/admin/sales paired masing-masing berhasil reset password sendiri", async () => {
    for (const [id, role] of [[OWNER_ID, "owner"], [ADMIN_ID, "admin"], [SALES_ID, "sales"]] as const) {
      const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
      seed(repo, { id, roles: [role] });

      const result = await resetTenantUserPassword(repo, { actorId: id, targetUserId: id });

      expect(result.outcome).toBe("reset");
      if (result.outcome === "reset") {
        expect(result.tempPassword.length).toBeGreaterThan(16);
      }
      expect(repo.getMustChangePassword(id)).toBe(true);
    }
  });

  it("2. actorId beda dari targetUserId ditolak forbidden (bukan self-service)", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"] });
    seed(repo, { id: ADMIN_ID, roles: ["admin"] });

    const result = await resetTenantUserPassword(repo, { actorId: ADMIN_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("forbidden");
    expect(repo.authUpdateCallCount).toBe(0);
  });

  it("3. target tanpa telegram pairing aktif ditolak (fail-closed, tidak diam-diam diizinkan)", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"], hasActiveTelegramPairing: false });

    const result = await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("target_not_found");
    expect(repo.authUpdateCallCount).toBe(0);
  });

  it("4. target tidak aktif ditolak", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"], isActive: false });

    const result = await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("target_inactive");
  });

  it("5. super_admin TIDAK bisa self-service reset lewat jalur ini (role tidak eligible)", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["super_admin"] });

    const result = await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("target_role_not_resettable");
  });

  it("6. reset kedua untuk target yang sama sementara operasi pertama masih in-flight ditolak", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"] });
    repo.beginReset = repo.beginReset.bind(repo);

    // Simulasikan operasi pertama sudah "started" tapi belum finalize --
    // panggil beginReset langsung (bukan resetTenantUserPassword penuh)
    // supaya inFlight ter-set tanpa langsung finalize.
    const first = await repo.beginReset({ operationId: "op-1", actorId: OWNER_ID, targetUserId: OWNER_ID });
    expect(first.ok).toBe(true);
    expect(repo.isInFlight(OWNER_ID)).toBe(true);

    const second = await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });
    expect(second.outcome).toBe("already_in_progress");
  });

  it("7. kegagalan auth.admin.updateUserById() tidak pernah mengembalikan tempPassword, target tetap fail-closed", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"] });
    repo.failAuthUpdate = true;

    const result = await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });

    expect(result.outcome).toBe("auth_update_failed");
    expect(repo.getMustChangePassword(OWNER_ID)).toBe(true);
    expect(repo.getAuditTrail().some((e) => e.action.includes("failed"))).toBe(true);
  });

  it("8. audit trail memakai action self-service (bukan action super_admin)", async () => {
    const repo = new InMemoryTelegramSelfServicePasswordResetRepository();
    seed(repo, { id: OWNER_ID, roles: ["owner"] });

    await resetTenantUserPassword(repo, { actorId: OWNER_ID, targetUserId: OWNER_ID });

    const actions = repo.getAuditTrail().map((e) => e.action);
    expect(actions).toContain("tenant_user.telegram_reset_started");
    expect(actions).toContain("tenant_user.telegram_reset_completed");
    expect(actions.every((a) => !a.startsWith("super_admin"))).toBe(true);
  });
});
