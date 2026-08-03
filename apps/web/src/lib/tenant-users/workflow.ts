import { validateCreateTenantUserInput } from "./service";
import { generateSecureTempPassword } from "./password";
import type { TenantUserRepository } from "./repository";
import type { CreateTenantUserInput, CreateTenantUserResult } from "./types";

/**
 * Membuat satu user tenant baru (admin | sales) secara atomic dengan
 * compensation: kegagalan pada langkah manapun setelah auth user dibuat
 * memicu rollback (hapus auth user, yang men-cascade profile via FK ON
 * DELETE CASCADE) sehingga tidak pernah meninggalkan data yatim -- pola
 * identik salesman/workflow.ts (createSalesman), digeneralisasi untuk
 * role allowlist {admin, sales} tanpa wilayah kerja.
 *
 * companyId dan actorId WAJIB berasal dari sesi server terautentikasi (lihat
 * actions.ts) -- fungsi ini tidak pernah menerima nilai tersebut dari input
 * yang bisa dipengaruhi client. Otorisasi actor (owner aktif, tenant sama)
 * dan allowlist role di-verifikasi ULANG di dalam RPC
 * provision_owner_created_tenant_user (database sebagai authorization
 * backstop, bukan hanya actions.ts) -- workflow ini tidak boleh dianggap
 * satu-satunya lapisan pemeriksaan.
 */
export async function createTenantUser(
  repo: TenantUserRepository,
  input: CreateTenantUserInput
): Promise<CreateTenantUserResult> {
  const validationError = validateCreateTenantUserInput({
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    role: input.role,
  });
  if (validationError) return { outcome: "invalid_input", error: validationError };

  const roleId = await repo.findRoleIdByName(input.role);
  if (!roleId) return { outcome: "invalid_role" };

  // Dibuat SEKALI di sini, dipakai untuk createAuthUser di bawah, dan
  // dikembalikan tepat satu kali pada outcome "created" -- tidak pernah
  // disimpan/di-log di tempat lain (lihat actions.ts, repository.ts).
  const tempPassword = generateSecureTempPassword();

  const authResult = await repo.createAuthUser({
    email: input.email,
    password: tempPassword,
    fullName: input.fullName,
  });
  if (!authResult.ok) {
    if (authResult.reason === "email_exists") return { outcome: "duplicate_email" };
    return { outcome: "unexpected_error", error: authResult.message };
  }

  const provisionResult = await repo.provisionTenantUser({
    actorId: input.actorId,
    companyId: input.companyId,
    userId: authResult.userId,
    roleId,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
  });

  if (!provisionResult.ok) {
    await repo.deleteAuthUser(authResult.userId);
    if (provisionResult.reason === "forbidden") return { outcome: "forbidden" };
    if (provisionResult.reason === "invalid_role") return { outcome: "invalid_role" };
    if (provisionResult.reason === "invalid_input") {
      return { outcome: "invalid_input", error: provisionResult.message };
    }
    return { outcome: "partial_failure_rolled_back", error: provisionResult.message };
  }

  return { outcome: "created", userId: authResult.userId, tempPassword };
}
