// =============================================================================
// Validasi murni (tanpa I/O) untuk input Owner Membuat User Tenant.
// Pola identik salesman/service.ts (validateCreateSalesmanInput).
// =============================================================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TENANT_ASSIGNABLE_ROLES = ["admin", "sales"] as const;

export function isTenantAssignableRole(role: string): role is "admin" | "sales" {
  return (TENANT_ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Tidak ada parameter tempPassword di sini -- password sementara SELALU
 * dibuat server-side (lihat password.ts, generateSecureTempPassword()),
 * tidak pernah input owner/client (berbeda dari salesman/service.ts lama).
 */
export function validateCreateTenantUserInput(input: {
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
}): string | null {
  if (!isTenantAssignableRole(input.role)) {
    return "Role tidak valid. Hanya admin atau sales yang dapat dibuat oleh owner.";
  }
  if (!input.fullName || input.fullName.trim().length < 2) {
    return "Nama lengkap wajib diisi (minimal 2 karakter).";
  }
  if (!input.email || !EMAIL_PATTERN.test(input.email.trim())) {
    return "Email tidak valid.";
  }
  if (input.phone && input.phone.trim().length > 0 && !/^[0-9+()\- ]{6,20}$/.test(input.phone.trim())) {
    return "Nomor telepon tidak valid.";
  }
  return null;
}
