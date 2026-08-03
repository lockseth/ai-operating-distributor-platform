// =============================================================================
// Owner Membuat User Tenant (admin | sales) -- Gate 3E-C-C2-B1.
//
// Generalisasi dari salesman/types.ts (CreateSalesmanInput/Result), TANPA
// wilayah kerja (out of scope gate ini -- salesman/coverage-area tetap lewat
// createSalesmanAction lama, TIDAK disentuh). Field sengaja terbatas pada
// kontrak gate: full_name, email, role (allowlist), phone opsional.
// Role SELALU allowlist {admin, sales} -- 'owner'/'super_admin'/nilai lain
// APAPUN ditolak baik di validasi TS (assertTenantAssignableRole) maupun
// ulang di RPC (is_tenant_assignable_role, migration 20260911000001).
// =============================================================================

export type TenantAssignableRole = "admin" | "sales";

export interface CreateTenantUserInput {
  companyId: string;
  actorId: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: TenantAssignableRole;
}

export type CreateTenantUserResult =
  | { outcome: "created"; userId: string; tempPassword: string }
  | { outcome: "invalid_input"; error: string }
  | { outcome: "invalid_role" }
  | { outcome: "duplicate_email" }
  | { outcome: "forbidden" }
  | { outcome: "partial_failure_rolled_back"; error: string }
  | { outcome: "unexpected_error"; error: string };
