// =============================================================================
// Validasi murni (tanpa I/O) untuk input Tambah Salesman.
// =============================================================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreateSalesmanInput(input: {
  fullName: string;
  email: string;
  phone: string | null;
  tempPassword: string;
}): string | null {
  if (!input.fullName || input.fullName.trim().length < 2) {
    return "Nama lengkap wajib diisi (minimal 2 karakter).";
  }
  if (!input.email || !EMAIL_PATTERN.test(input.email.trim())) {
    return "Email tidak valid.";
  }
  if (!input.tempPassword || input.tempPassword.length < 8) {
    return "Password sementara minimal 8 karakter.";
  }
  if (input.phone && input.phone.trim().length > 0 && !/^[0-9+()\- ]{6,20}$/.test(input.phone.trim())) {
    return "Nomor telepon tidak valid.";
  }
  return null;
}
