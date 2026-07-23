"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseCoverageAreaRepository } from "./repository";
import { validateCoverageAreaName } from "./service";

// Owner-only by explicit product decision (Owner Control Gate 1A) — lebih
// ketat dari MANAGE_ROLES yang dipakai fitur salesman lain (manager/admin/
// super_admin), karena "membuat wilayah baru" adalah kewenangan baru yang
// sengaja dibatasi hanya Owner tenant.
const OWNER_ONLY_ROLES = ["owner"];

function isOwnerActor(user: { roles: string[] }): boolean {
  return OWNER_ONLY_ROLES.some((role) => user.roles.includes(role));
}

export interface CreateCoverageAreaActionResult {
  ok: boolean;
  error?: string;
  areas?: string[];
  createdArea?: string;
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
    return { ok: true, areas: result.areas, createdArea: trimmedName };
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
