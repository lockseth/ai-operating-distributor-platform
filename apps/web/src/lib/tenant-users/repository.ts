import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantAssignableRole } from "./types";

export type CreateAuthUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "email_exists" | "other"; message: string };

export type ProvisionTenantUserResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "invalid_role" | "invalid_input" | "unexpected"; message: string };

export interface TenantUserRepository {
  createAuthUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<CreateAuthUserResult>;

  deleteAuthUser(userId: string): Promise<void>;

  /** System role lookup (company_id IS NULL) -- pola identik findSalesRoleId(). */
  findRoleIdByName(role: TenantAssignableRole): Promise<string | null>;

  /**
   * Provisioning atomic (profile + role + audit + password-hash snapshot)
   * lewat RPC public.provision_owner_created_tenant_user -- RPC re-verifikasi
   * actor (owner aktif, tenant sama) dan role allowlist SENDIRI, tidak pernah
   * mempercayai bahwa caller (actions.ts) sudah memeriksa.
   */
  provisionTenantUser(input: {
    actorId: string;
    companyId: string;
    userId: string;
    roleId: string;
    fullName: string;
    email: string;
    phone: string | null;
  }): Promise<ProvisionTenantUserResult>;
}

export class SupabaseTenantUserRepository implements TenantUserRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async createAuthUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<CreateAuthUserResult> {
    const { data, error } = await this.supabase.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName },
    });

    if (error) {
      if (error.message.toLowerCase().includes("already registered") || error.status === 422) {
        return { ok: false, reason: "email_exists", message: error.message };
      }
      return { ok: false, reason: "other", message: error.message };
    }

    return { ok: true, userId: data.user.id };
  }

  async deleteAuthUser(userId: string): Promise<void> {
    await this.supabase.auth.admin.deleteUser(userId).catch(() => {});
  }

  async findRoleIdByName(role: TenantAssignableRole): Promise<string | null> {
    const { data } = await this.supabase
      .from("roles")
      .select("id")
      .eq("name", role)
      .is("company_id", null)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  async provisionTenantUser(input: {
    actorId: string;
    companyId: string;
    userId: string;
    roleId: string;
    fullName: string;
    email: string;
    phone: string | null;
  }): Promise<ProvisionTenantUserResult> {
    const { data, error } = await this.supabase.rpc("provision_owner_created_tenant_user", {
      p_actor_id: input.actorId,
      p_company_id: input.companyId,
      p_user_id: input.userId,
      p_role_id: input.roleId,
      p_full_name: input.fullName,
      p_email: input.email,
      p_phone: input.phone,
    });

    if (error) return { ok: false, reason: "unexpected", message: error.message };

    const row = ((data ?? []) as { result_outcome: string }[])[0];
    if (!row) return { ok: false, reason: "unexpected", message: "empty RPC result" };

    switch (row.result_outcome) {
      case "provisioned":
        return { ok: true };
      case "forbidden":
        return { ok: false, reason: "forbidden", message: "forbidden" };
      case "invalid_role":
        return { ok: false, reason: "invalid_role", message: "invalid_role" };
      case "invalid_input":
        return { ok: false, reason: "invalid_input", message: "invalid_input" };
      default:
        return { ok: false, reason: "unexpected", message: `unknown outcome: ${row.result_outcome}` };
    }
  }
}

// -----------------------------------------------------------------------
// InMemory -- untuk unit test. Mensimulasikan cascade delete auth->profile
// dan re-verifikasi actor/role di dalam "RPC" (mencerminkan bahwa RPC
// sungguhan re-check otorisasi sendiri, bukan hanya mempercayai caller).
// -----------------------------------------------------------------------

interface InMemoryUserRow {
  id: string;
  companyId: string;
  email: string;
  fullName: string;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
}

const ROLE_IDS: Record<TenantAssignableRole, string> = {
  admin: "role-admin",
  sales: "role-sales",
};

export class InMemoryTenantUserRepository implements TenantUserRepository {
  private authEmails = new Set<string>();
  private authEmailByUserId = new Map<string, string>();
  private users = new Map<string, InMemoryUserRow>();
  private userRoles: { userId: string; roleId: string; companyId: string; assignedBy: string; roleName: string }[] = [];
  private actorRoles: { userId: string; companyId: string; roleName: string; isActive: boolean }[] = [];
  private auditTrail: { action: string; companyId: string; actorId: string; entityId: string }[] = [];
  private nextId = 1;

  roleLookupReturnsNull = false;
  failProvisionWithReason: ProvisionTenantUserResult | null = null;

  seedExistingEmail(email: string): void {
    this.authEmails.add(email.toLowerCase());
  }

  /** Simulasi actor owner/manager/admin/sales/super_admin, aktif atau tidak, pada satu tenant. */
  seedActorRole(userId: string, companyId: string, roleName: string, isActive = true): void {
    this.actorRoles.push({ userId, companyId, roleName, isActive });
  }

  getUser(userId: string): InMemoryUserRow | undefined {
    return this.users.get(userId);
  }
  getRolesFor(userId: string) {
    return this.userRoles.filter((r) => r.userId === userId);
  }
  getAuditTrail() {
    return this.auditTrail;
  }
  hasAnyOrphanRole(): boolean {
    return this.userRoles.some((r) => !this.users.has(r.userId));
  }
  totalUsers(): number {
    return this.users.size;
  }

  async createAuthUser(input: { email: string; password: string; fullName: string }): Promise<CreateAuthUserResult> {
    const normalized = input.email.toLowerCase();
    if (this.authEmails.has(normalized)) {
      return { ok: false, reason: "email_exists", message: "A user with this email address has already been registered" };
    }
    const userId = `user-${this.nextId++}`;
    this.authEmails.add(normalized);
    this.authEmailByUserId.set(userId, normalized);
    return { ok: true, userId };
  }

  async deleteAuthUser(userId: string): Promise<void> {
    const email = this.authEmailByUserId.get(userId);
    if (email) this.authEmails.delete(email);
    this.authEmailByUserId.delete(userId);
    this.users.delete(userId);
    this.userRoles = this.userRoles.filter((r) => r.userId !== userId);
  }

  async findRoleIdByName(role: TenantAssignableRole): Promise<string | null> {
    return this.roleLookupReturnsNull ? null : ROLE_IDS[role];
  }

  async provisionTenantUser(input: {
    actorId: string;
    companyId: string;
    userId: string;
    roleId: string;
    fullName: string;
    email: string;
    phone: string | null;
  }): Promise<ProvisionTenantUserResult> {
    if (this.failProvisionWithReason) return this.failProvisionWithReason;

    // Re-verifikasi actor: owner AKTIF pada tenant yang SAMA -- mencerminkan
    // pengecekan di dalam provision_owner_created_tenant_user() (SQL), bukan
    // hanya mengandalkan bahwa caller (actions.ts) sudah memeriksa.
    const actorAllowed = this.actorRoles.some(
      (r) => r.userId === input.actorId && r.companyId === input.companyId && r.roleName === "owner" && r.isActive
    );
    if (!actorAllowed) return { ok: false, reason: "forbidden", message: "forbidden" };

    // Re-verifikasi role allowlist: hanya role_id yang resolve ke admin/sales.
    const roleEntry = Object.entries(ROLE_IDS).find(([, id]) => id === input.roleId);
    if (!roleEntry) return { ok: false, reason: "invalid_role", message: "invalid_role" };
    const roleName = roleEntry[0];

    if (!input.fullName || input.fullName.trim().length < 2) {
      return { ok: false, reason: "invalid_input", message: "invalid_input" };
    }

    this.users.set(input.userId, {
      id: input.userId,
      companyId: input.companyId,
      email: input.email,
      fullName: input.fullName,
      phone: input.phone,
      isActive: true,
      mustChangePassword: true,
    });
    this.userRoles.push({
      userId: input.userId,
      roleId: input.roleId,
      companyId: input.companyId,
      assignedBy: input.actorId,
      roleName,
    });
    this.auditTrail.push({
      action: "tenant_user.created",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: input.userId,
    });

    return { ok: true };
  }
}
