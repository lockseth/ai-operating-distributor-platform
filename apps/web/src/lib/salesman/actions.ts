"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { logAuditEvent } from "@/lib/actions/audit";
import { createSalesman } from "./workflow";
import { SupabaseSalesmanRepository } from "./repository";

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

function canManageSalesman(user: { roles: string[]; permissions: string[] }): boolean {
  return (
    hasPermission(user.permissions, "users.manage") ||
    MANAGE_ROLES.some((role) => user.roles.includes(role))
  );
}

// Owner Control Plane (corrective closure 2026-07-23): Tambah Salesman,
// Tambah Wilayah, dan Ubah Wilayah Salesman existing satu domain otorisasi
// -- owner-only, lebih ketat dari canManageSalesman/MANAGE_ROLES di atas.
// Dipakai oleh createSalesmanAction DAN updateSalesmanCoverageAreasAction.
function isOwnerActor(user: { roles: string[] }): boolean {
  return user.roles.includes("owner");
}

export interface CreateSalesmanFormInput {
  fullName: string;
  email: string;
  phone: string;
  tempPassword: string;
  areaIds: string[];
}

export interface CreateSalesmanActionResult {
  ok: boolean;
  error?: string;
}

const OUTCOME_MESSAGE: Record<string, string> = {
  duplicate_email: "Email sudah terdaftar di sistem.",
  role_not_found: "Role Salesman tidak ditemukan. Hubungi administrator sistem.",
  no_areas_provided: "Pilih minimal satu wilayah kerja.",
  no_coverage_configured: "Tenant ini belum memiliki wilayah kerja. Tambahkan wilayah terlebih dahulu dari form Tambah Salesman.",
  invalid_area: "Wilayah yang dipilih tidak terdaftar pada konfigurasi tenant.",
};

export async function createSalesmanAction(
  input: CreateSalesmanFormInput
): Promise<CreateSalesmanActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Tambah Salesman tidak tersedia pada sesi demo." };
  }
  if (!canManageSalesman(user) || !isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat menambahkan Salesman." };
  }

  const repo = new SupabaseSalesmanRepository(getAdminClient());
  const result = await createSalesman(repo, {
    companyId: user.company_id,
    actorId: user.id,
    fullName: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
    tempPassword: input.tempPassword,
    areaIds: input.areaIds ?? [],
  });

  if (result.outcome === "created") {
    await logAuditEvent({
      company_id: user.company_id,
      user_id: user.id,
      action: "salesman.created",
      entity_type: "users",
      entity_id: result.userId,
      new_data: { email: input.email.trim().toLowerCase(), full_name: input.fullName.trim() },
    }).catch(() => {});

    revalidatePath("/dashboard/users");
    return { ok: true };
  }

  if (result.outcome === "invalid_input") {
    return { ok: false, error: result.error };
  }
  if (result.outcome === "partial_failure_rolled_back" || result.outcome === "unexpected_error") {
    console.error("[Salesman] creation failed", result.outcome, result.error);
    return { ok: false, error: "Gagal membuat Salesman. Coba lagi atau hubungi administrator." };
  }

  return { ok: false, error: OUTCOME_MESSAGE[result.outcome] ?? "Gagal membuat Salesman." };
}

export interface UpdateCoverageAreasActionResult {
  ok: boolean;
  error?: string;
  assignedCount?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mengubah (replace penuh) wilayah kerja satu Salesman existing. Idempotent — memanggil ulang dengan wilayah yang sama tidak menghasilkan efek tambahan. */
export async function updateSalesmanCoverageAreasAction(
  salesmanId: string,
  areaIds: string[]
): Promise<UpdateCoverageAreasActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Perubahan wilayah tidak tersedia pada sesi demo." };
  }
  if (!canManageSalesman(user) || !isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat mengubah wilayah kerja Salesman." };
  }
  if (!UUID_PATTERN.test(salesmanId)) {
    return { ok: false, error: "Salesman tidak valid." };
  }

  const repo = new SupabaseSalesmanRepository(getAdminClient());
  const result = await repo.assignCoverageAreas({
    companyId: user.company_id,
    userId: salesmanId,
    areaIds,
    actorId: user.id,
  });

  if (result.outcome === "assigned") {
    revalidatePath("/dashboard/users");
    return { ok: true, assignedCount: result.assignedCount };
  }
  if (result.outcome === "forbidden" || result.outcome === "not_eligible") {
    return { ok: false, error: "Salesman tidak ditemukan pada tenant Anda atau bukan role Salesman aktif." };
  }
  if (result.outcome === "unexpected_error") {
    console.error("[Salesman] update coverage areas failed", result.error);
    return { ok: false, error: "Gagal memperbarui wilayah kerja. Coba lagi atau hubungi administrator." };
  }

  return { ok: false, error: OUTCOME_MESSAGE[result.outcome] ?? "Gagal memperbarui wilayah kerja." };
}
