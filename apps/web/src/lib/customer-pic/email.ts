// =============================================================================
// Normalisasi + validasi format email PIC — pure function, SENGAJA
// dicerminkan persis dari public.normalize_id_email() dan regex validasi di
// RPC create_store_with_pic/create_customer_pic/update_customer_pic
// (migration 20260730000001_customer_pic_email.sql).
//
// Email PIC: opsional, tidak ada OTP/email verification, TIDAK PERNAH jadi
// bukti PIC verified, TIDAK wajib unique (keputusan Pak Waluyo).
// =============================================================================

/** Trim + lowercase. Kosong/null/undefined -> null. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === "") return null;
  return email.trim().toLowerCase();
}

/**
 * Validasi format RINGAN (bukan RFC 5322 penuh) -- konsisten dengan regex
 * SQL '^[^@\s]+@[^@\s]+\.[^@\s]+$'. Hanya dipanggil untuk email yang SUDAH
 * dinormalisasi/non-null (kosong selalu valid di layer atasnya).
 */
export function isValidEmailFormat(normalizedEmail: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail);
}
