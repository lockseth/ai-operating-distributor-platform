import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignCoverageAreasResult } from "./types";

export type CreateAuthUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "email_exists" | "other"; message: string };

export type WriteResult = { ok: true } | { ok: false; message: string };

export interface SalesmanRepository {
  createAuthUser(input: {
    email: string;
    password: string;
    fullName: string;
  }): Promise<CreateAuthUserResult>;

  deleteAuthUser(userId: string): Promise<void>;

  insertProfile(input: {
    userId: string;
    companyId: string;
    email: string;
    fullName: string;
    phone: string | null;
  }): Promise<WriteResult>;

  findSalesRoleId(): Promise<string | null>;

  assignSalesRole(input: {
    userId: string;
    roleId: string;
    companyId: string;
    assignedBy: string;
  }): Promise<WriteResult>;

  /** Replace penuh (bukan tambah) — memanggil ulang dengan wilayah yang sama bersifat idempotent. */
  assignCoverageAreas(input: {
    companyId: string;
    userId: string;
    areaIds: string[];
    actorId: string;
  }): Promise<AssignCoverageAreasResult>;
}

export class SupabaseSalesmanRepository implements SalesmanRepository {
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

  async insertProfile(input: {
    userId: string;
    companyId: string;
    email: string;
    fullName: string;
    phone: string | null;
  }): Promise<WriteResult> {
    const { error } = await this.supabase.from("users").insert({
      id: input.userId,
      company_id: input.companyId,
      email: input.email,
      full_name: input.fullName,
      phone: input.phone,
      is_active: true,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  }

  async findSalesRoleId(): Promise<string | null> {
    const { data } = await this.supabase
      .from("roles")
      .select("id")
      .eq("name", "sales")
      .is("company_id", null)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  async assignSalesRole(input: {
    userId: string;
    roleId: string;
    companyId: string;
    assignedBy: string;
  }): Promise<WriteResult> {
    const { error } = await this.supabase.from("user_roles").insert({
      user_id: input.userId,
      role_id: input.roleId,
      company_id: input.companyId,
      assigned_by: input.assignedBy,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  }

  async assignCoverageAreas(input: {
    companyId: string;
    userId: string;
    areaIds: string[];
    actorId: string;
  }): Promise<AssignCoverageAreasResult> {
    const { data, error } = await this.supabase.rpc("assign_salesman_coverage_areas", {
      p_company_id: input.companyId,
      p_user_id: input.userId,
      p_area_ids: input.areaIds,
      p_actor_id: input.actorId,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = (
      (data ?? []) as { result_outcome: string; assigned_count: number }[]
    )[0];

    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "assigned":
        return { outcome: "assigned", assignedCount: row.assigned_count };
      case "forbidden":
        return { outcome: "forbidden" };
      case "not_eligible":
        return { outcome: "not_eligible" };
      case "no_areas_provided":
        return { outcome: "no_areas_provided" };
      case "no_coverage_configured":
        return { outcome: "no_coverage_configured" };
      case "invalid_area":
        return { outcome: "invalid_area" };
      default:
        return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
    }
  }
}

// -----------------------------------------------------------------------
// InMemory — untuk test. Mensimulasikan cascade delete auth->profile (FK
// public.users.id REFERENCES auth.users.id ON DELETE CASCADE) dan
// mendukung injeksi kegagalan sekali-pakai untuk menguji rollback.
// -----------------------------------------------------------------------

interface InMemoryUserRow {
  id: string;
  companyId: string;
  email: string;
  fullName: string;
  phone: string | null;
}

// Owner Control Plane (corrective closure 2026-07-23): Tambah Salesman,
// Tambah Wilayah, dan Ubah Wilayah Salesman existing memakai satu model
// otorisasi yang sama -- owner-only. Mencerminkan actor check di RPC
// assign_salesman_coverage_areas (migration 20260814000001).
const OWNER_ONLY_ROLES = ["owner"];

interface InMemoryAuditEvent {
  action: string;
  companyId: string;
  actorId: string;
  entityId: string;
  oldData: unknown;
  newData: unknown;
}

export class InMemorySalesmanRepository implements SalesmanRepository {
  private authEmails = new Set<string>();
  private authEmailByUserId = new Map<string, string>();
  private users = new Map<string, InMemoryUserRow>();
  private userRoles: { userId: string; roleId: string; companyId: string; assignedBy: string; roleName?: string }[] = [];
  private nextId = 1;

  private tenantCoverageAreas = new Map<string, string[]>();
  private coverageAssignments = new Map<string, string[]>(); // key: `${companyId}:${userId}`
  private auditTrail: InMemoryAuditEvent[] = [];
  // Terpisah dari userRoles (yang HANYA berisi role 'sales' hasil assignSalesRole,
  // dipasangkan 1:1 dengan users yang dibuat) supaya seed actor (owner/manager/
  // dst — sengaja TIDAK punya baris `users`, sama seperti admin sungguhan yang
  // bukan bagian dari flow pembuatan salesman) tidak terhitung sebagai orphan
  // role oleh hasAnyOrphanRole().
  private actorRoles: { userId: string; companyId: string; roleName: string }[] = [];

  readonly salesRoleId = "role-sales";

  failNextProfileInsert = false;
  failNextRoleAssign = false;
  roleLookupReturnsNull = false;

  seedExistingEmail(email: string): void {
    this.authEmails.add(email.toLowerCase());
  }

  /** Simulasi peran actor (owner/manager/admin/super_admin) untuk uji otorisasi assignCoverageAreas secara langsung (di luar alur createSalesman). */
  seedActorRole(userId: string, companyId: string, roleName: string): void {
    this.actorRoles.push({ userId, companyId, roleName });
  }

  /** Simulasi daftar coverage_area_id valid (master coverage_areas) milik satu tenant. */
  setTenantCoverageAreas(companyId: string, areaIds: string[]): void {
    this.tenantCoverageAreas.set(companyId, areaIds);
  }

  getCoverageAreasFor(companyId: string, userId: string): string[] {
    return this.coverageAssignments.get(`${companyId}:${userId}`) ?? [];
  }

  getAuditTrail(): InMemoryAuditEvent[] {
    return this.auditTrail;
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
    for (const key of [...this.coverageAssignments.keys()]) {
      if (key.endsWith(`:${userId}`)) this.coverageAssignments.delete(key);
    }
  }

  async insertProfile(input: {
    userId: string;
    companyId: string;
    email: string;
    fullName: string;
    phone: string | null;
  }): Promise<WriteResult> {
    if (this.failNextProfileInsert) {
      this.failNextProfileInsert = false;
      return { ok: false, message: "simulated profile insert failure" };
    }
    this.users.set(input.userId, {
      id: input.userId,
      companyId: input.companyId,
      email: input.email,
      fullName: input.fullName,
      phone: input.phone,
    });
    return { ok: true };
  }

  async findSalesRoleId(): Promise<string | null> {
    return this.roleLookupReturnsNull ? null : this.salesRoleId;
  }

  async assignSalesRole(input: {
    userId: string;
    roleId: string;
    companyId: string;
    assignedBy: string;
  }): Promise<WriteResult> {
    if (this.failNextRoleAssign) {
      this.failNextRoleAssign = false;
      return { ok: false, message: "simulated role assign failure" };
    }
    this.userRoles.push({ ...input, roleName: "sales" });
    return { ok: true };
  }

  async assignCoverageAreas(input: {
    companyId: string;
    userId: string;
    areaIds: string[];
    actorId: string;
  }): Promise<AssignCoverageAreasResult> {
    const actorAllowed = this.actorRoles.some(
      (r) => r.userId === input.actorId && r.companyId === input.companyId && OWNER_ONLY_ROLES.includes(r.roleName)
    );
    if (!actorAllowed) return { outcome: "forbidden" };

    const targetUser = this.users.get(input.userId);
    const targetIsSales = this.userRoles.some(
      (r) => r.userId === input.userId && r.companyId === input.companyId && r.roleName === "sales"
    );
    if (!targetUser || targetUser.companyId !== input.companyId || !targetIsSales) {
      return { outcome: "not_eligible" };
    }

    const distinct = [...new Set(input.areaIds.map((a) => a.trim()).filter((a) => a.length > 0))];
    if (distinct.length === 0) return { outcome: "no_areas_provided" };

    const available = this.tenantCoverageAreas.get(input.companyId) ?? [];
    if (available.length === 0) return { outcome: "no_coverage_configured" };

    for (const area of distinct) {
      if (!available.includes(area)) return { outcome: "invalid_area" };
    }

    const key = `${input.companyId}:${input.userId}`;
    const oldAreas = this.coverageAssignments.get(key) ?? [];
    this.coverageAssignments.set(key, distinct);

    this.auditTrail.push({
      action: "salesman.coverage_area_updated",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: input.userId,
      oldData: { areas: oldAreas },
      newData: { areas: distinct },
    });

    return { outcome: "assigned", assignedCount: distinct.length };
  }

  // -- test helpers --
  getUser(userId: string): InMemoryUserRow | undefined {
    return this.users.get(userId);
  }
  getRolesFor(userId: string) {
    return this.userRoles.filter((r) => r.userId === userId);
  }
  hasAnyOrphanRole(): boolean {
    return this.userRoles.some((r) => !this.users.has(r.userId));
  }
  totalUsers(): number {
    return this.users.size;
  }
}
