"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseCoverageAreaRepository } from "./repository";
import { validateCoverageAreaName } from "./service";
import type { CoverageArea } from "./types";

// Owner-only by explicit product decision (Owner Control Gate 1A) — membuat,
// mengubah, dan mengaktifkan/nonaktifkan Wilayah Penjualan adalah kewenangan
// yang sengaja dibatasi hanya Owner tenant (lebih ketat dari MANAGE_ROLES
// yang dipakai fitur lain).
const OWNER_ONLY_ROLES = ["owner"];

function isOwnerActor(user: { roles: string[] }): boolean {
  return OWNER_ONLY_ROLES.some((role) => user.roles.includes(role));
}

export interface CreateCoverageAreaActionResult {
  ok: boolean;
  error?: string;
  area?: CoverageArea;
}

export async function createCoverageAreaAction(
  name: string,
  description: string
): Promise<CreateCoverageAreaActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Tambah wilayah tidak tersedia pada sesi demo." };
  }
  if (!isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat menambahkan wilayah kerja." };
  }

  const trimmedName = (name ?? "").trim();
  const validationError = validateCoverageAreaName(trimmedName);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const repo = new SupabaseCoverageAreaRepository(getAdminClient());
  const result = await repo.createArea({
    companyId: user.company_id,
    actorId: user.id,
    name: trimmedName,
    description: description?.trim() || null,
  });

  if (result.outcome === "created") {
    revalidatePath("/dashboard/users/new");
    revalidatePath("/dashboard/owner/coverage-areas");
    return { ok: true, area: result.area };
  }
  if (result.outcome === "duplicate_area") {
    return { ok: false, error: "Wilayah dengan nama ini sudah terdaftar (tidak case-sensitive)." };
  }
  if (result.outcome === "forbidden") {
    return { ok: false, error: "Hanya Owner tenant yang dapat menambahkan wilayah kerja." };
  }
  if (result.outcome === "invalid_name") {
    return { ok: false, error: result.error };
  }

  console.error("[CoverageArea] create failed", result.outcome, result.error);
  return { ok: false, error: "Gagal menambahkan wilayah. Coba lagi atau hubungi administrator." };
}

export interface UpdateCoverageAreaActionResult {
  ok: boolean;
  error?: string;
  area?: CoverageArea;
}

export async function updateCoverageAreaAction(
  areaId: string,
  name: string,
  description: string
): Promise<UpdateCoverageAreaActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Edit wilayah tidak tersedia pada sesi demo." };
  }
  if (!isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat mengedit wilayah kerja." };
  }

  const trimmedName = (name ?? "").trim();
  const validationError = validateCoverageAreaName(trimmedName);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const repo = new SupabaseCoverageAreaRepository(getAdminClient());
  const result = await repo.updateArea({
    companyId: user.company_id,
    actorId: user.id,
    areaId,
    name: trimmedName,
    description: description?.trim() || null,
  });

  if (result.outcome === "updated") {
    revalidatePath("/dashboard/owner/coverage-areas");
    revalidatePath("/dashboard/users");
    revalidatePath("/dashboard/customers");
    return { ok: true, area: result.area };
  }
  if (result.outcome === "duplicate_area") {
    return { ok: false, error: "Wilayah dengan nama ini sudah terdaftar (tidak case-sensitive)." };
  }
  if (result.outcome === "forbidden") {
    return { ok: false, error: "Hanya Owner tenant yang dapat mengedit wilayah kerja." };
  }
  if (result.outcome === "not_found") {
    return { ok: false, error: "Wilayah tidak ditemukan pada tenant Anda." };
  }
  if (result.outcome === "invalid_name") {
    return { ok: false, error: result.error };
  }

  console.error("[CoverageArea] update failed", result.outcome, result.error);
  return { ok: false, error: "Gagal mengedit wilayah. Coba lagi atau hubungi administrator." };
}

export interface SetCoverageAreaActiveStatusActionResult {
  ok: boolean;
  error?: string;
  active?: boolean;
}

export async function setCoverageAreaActiveStatusAction(
  areaId: string,
  isActive: boolean
): Promise<SetCoverageAreaActiveStatusActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Perubahan status wilayah tidak tersedia pada sesi demo." };
  }
  if (!isOwnerActor(user)) {
    return { ok: false, error: "Hanya Owner tenant yang dapat mengaktifkan/menonaktifkan wilayah kerja." };
  }

  const repo = new SupabaseCoverageAreaRepository(getAdminClient());
  const result = await repo.setActiveStatus({
    companyId: user.company_id,
    actorId: user.id,
    areaId,
    isActive,
  });

  if (result.outcome === "activated" || result.outcome === "deactivated") {
    revalidatePath("/dashboard/owner/coverage-areas");
    revalidatePath("/dashboard/users");
    revalidatePath("/dashboard/users/new");
    revalidatePath("/dashboard/customers");
    return { ok: true, active: result.outcome === "activated" };
  }
  if (result.outcome === "unchanged") {
    revalidatePath("/dashboard/owner/coverage-areas");
    return { ok: true, active: isActive };
  }
  if (result.outcome === "forbidden") {
    return { ok: false, error: "Hanya Owner tenant yang dapat mengaktifkan/menonaktifkan wilayah kerja." };
  }
  if (result.outcome === "not_found") {
    return { ok: false, error: "Wilayah tidak ditemukan pada tenant Anda." };
  }

  console.error("[CoverageArea] set active status failed", result.error);
  return { ok: false, error: "Gagal mengubah status wilayah. Coba lagi atau hubungi administrator." };
}
