import { validateCreateSalesmanInput } from "./service";
import type { SalesmanRepository } from "./repository";
import type { CreateSalesmanInput, CreateSalesmanResult } from "./types";

/**
 * Membuat satu Salesman baru (auth user + profile + role) secara atomic
 * dengan compensation: kegagalan pada langkah manapun setelah auth user
 * dibuat memicu rollback (hapus auth user, yang men-cascade profile via
 * FK ON DELETE CASCADE) sehingga tidak pernah meninggalkan data yatim.
 *
 * companyId dan actorId WAJIB berasal dari sesi server terautentikasi
 * (lihat actions.ts) — fungsi ini tidak pernah menerima nilai tersebut
 * dari input yang bisa dipengaruhi client, dan role yang di-assign SELALU
 * 'sales' (dicari via findSalesRoleId(), tidak pernah parameter bebas).
 */
export async function createSalesman(
  repo: SalesmanRepository,
  input: CreateSalesmanInput
): Promise<CreateSalesmanResult> {
  const validationError = validateCreateSalesmanInput({
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    tempPassword: input.tempPassword,
  });
  if (validationError) return { outcome: "invalid_input", error: validationError };

  const roleId = await repo.findSalesRoleId();
  if (!roleId) return { outcome: "role_not_found" };

  const authResult = await repo.createAuthUser({
    email: input.email,
    password: input.tempPassword,
    fullName: input.fullName,
  });
  if (!authResult.ok) {
    if (authResult.reason === "email_exists") return { outcome: "duplicate_email" };
    return { outcome: "unexpected_error", error: authResult.message };
  }

  const profileResult = await repo.insertProfile({
    userId: authResult.userId,
    companyId: input.companyId,
    email: input.email,
    fullName: input.fullName,
    phone: input.phone,
  });
  if (!profileResult.ok) {
    await repo.deleteAuthUser(authResult.userId);
    return { outcome: "partial_failure_rolled_back", error: profileResult.message };
  }

  const roleResult = await repo.assignSalesRole({
    userId: authResult.userId,
    roleId,
    companyId: input.companyId,
    assignedBy: input.actorId,
  });
  if (!roleResult.ok) {
    await repo.deleteAuthUser(authResult.userId);
    return { outcome: "partial_failure_rolled_back", error: roleResult.message };
  }

  const areaResult = await repo.assignCoverageAreas({
    companyId: input.companyId,
    userId: authResult.userId,
    areaIds: input.areaIds,
    actorId: input.actorId,
  });
  if (areaResult.outcome !== "assigned") {
    await repo.deleteAuthUser(authResult.userId);
    if (areaResult.outcome === "no_areas_provided") return { outcome: "no_areas_provided" };
    if (areaResult.outcome === "no_coverage_configured") return { outcome: "no_coverage_configured" };
    if (areaResult.outcome === "invalid_area") return { outcome: "invalid_area" };
    if (areaResult.outcome === "unexpected_error")
      return { outcome: "partial_failure_rolled_back", error: areaResult.error };
    // forbidden/not_eligible tidak seharusnya terjadi di sini (actor & target
    // baru saja divalidasi/di-assign role sales pada langkah sebelumnya) —
    // perlakukan sebagai kegagalan tak terduga, tetap rollback.
    return { outcome: "partial_failure_rolled_back", error: `unexpected: ${areaResult.outcome}` };
  }

  return { outcome: "created", userId: authResult.userId };
}
