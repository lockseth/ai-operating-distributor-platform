// =============================================================================
// Validasi murni (tanpa I/O) untuk nama wilayah kerja baru.
// =============================================================================

export function validateCoverageAreaName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "Nama wilayah wajib diisi.";
  }
  if (trimmed.length > 100) {
    return "Nama wilayah maksimal 100 karakter.";
  }
  return null;
}
