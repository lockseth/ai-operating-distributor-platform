"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { getAdminClient } from "@/lib/supabase/admin";
import { createTenantUser } from "./workflow";
import { SupabaseTenantUserRepository } from "./repository";
import { isTenantAssignableRole } from "./service";

// Gate 3E-C-C2-B1 -- Owner Control Plane: satu domain otorisasi yang sama
// dengan createSalesmanAction (salesman/actions.ts) -- owner-only, BUKAN
// MANAGE_ROLES/canManageSalesman yang lebih longgar. super_admin TIDAK
// pernah termasuk (G7, docs/product/auth/
// AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md §7) -- super_admin
// adalah operator platform, tidak pernah tersedia lewat jalur tenant.
function isOwnerActor(user: { roles: string[] }): boolean {
  return user.roles.includes("owner");
}

export interface CreateTenantUserFormInput {
  fullName: string;
  email: string;
  phone: string;
  role: string;
}

export interface CreateTenantUserActionResult {
  ok: boolean;
  error?: string;
  /** Hanya terisi tepat satu kali pada response sukses -- lihat catatan di createTenantUserAction. */
  tempPassword?: string;
}

const OUTCOME_MESSAGE: Record<string, string> = {
  duplicate_email: "Email sudah terdaftar di sistem.",
  invalid_role: "Role tidak valid. Hanya admin atau sales yang dapat dibuat oleh owner.",
  forbidden: "Anda tidak berwenang membuat user untuk tenant ini.",
};

/**
 * Owner membuat user tenant baru (admin | sales) dengan temporary password --
 * user baru WAJIB mengganti password sebelum mengakses aplikasi (lihat
 * must_change_password, get-user.ts). Tidak ada invitation email -- temporary
 * password dikembalikan tepat satu kali pada response sukses, tidak pernah
 * disimpan plaintext, tidak pernah masuk log/audit (lihat
 * provision_owner_created_tenant_user(), migration 20260911000001).
 */
export async function createTenantUserAction(
  input: CreateTenantUserFormInput
): Promise<CreateTenantUserActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Tambah User tidak tersedia pada sesi demo." };
  }
  if (!isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat menambahkan user." };
  }
  if (!isTenantAssignableRole(input.role)) {
    return { ok: false, error: OUTCOME_MESSAGE.invalid_role };
  }

  const repo = new SupabaseTenantUserRepository(getAdminClient());
  const result = await createTenantUser(repo, {
    companyId: user.company_id,
    actorId: user.id,
    fullName: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
    role: input.role,
  });

  if (result.outcome === "created") {
    // Audit event ('tenant_user.created') sudah ditulis secara atomic DI
    // DALAM transaksi RPC provision_owner_created_tenant_user() -- tidak
    // diulang di sini (best-effort logAuditEvent terpisah akan redundan dan
    // lebih lemah daripada audit yang sudah tercatat atomic bersama profile
    // + role). Password TIDAK PERNAH disertakan di audit/log manapun --
    // dikembalikan HANYA di sini, tepat satu kali, ke pemanggil (owner)
    // yang sudah diverifikasi getAuthUser()+isOwnerActor() di atas.
    revalidatePath("/dashboard/users");
    return { ok: true, tempPassword: result.tempPassword };
  }

  if (result.outcome === "invalid_input") {
    return { ok: false, error: result.error };
  }
  if (result.outcome === "partial_failure_rolled_back" || result.outcome === "unexpected_error") {
    console.error("[TenantUsers] creation failed", result.outcome, result.error);
    return { ok: false, error: "Gagal membuat user. Coba lagi atau hubungi administrator." };
  }

  return { ok: false, error: OUTCOME_MESSAGE[result.outcome] ?? "Gagal membuat user." };
}
