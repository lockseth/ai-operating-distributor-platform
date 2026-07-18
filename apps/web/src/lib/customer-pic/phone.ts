// =============================================================================
// Normalisasi nomor telepon Indonesia — pure function, SENGAJA dicerminkan
// persis dari public.normalize_id_phone() (migration
// 20260728000001_customer_pic_master.sql) supaya InMemory repository dan RPC
// produksi selalu setuju pada hasil yang sama.
// =============================================================================

/**
 * Buang semua karakter non-digit, deteksi prefix 0/62/+62, normalisasi ke
 * "+62<sisanya>". String kosong/null -> null.
 */
export function normalizeIdPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined || phone.trim() === "") return null;

  const digits = phone.trim().replace(/[^0-9]/g, "");
  if (digits === "") return null;

  if (digits.startsWith("62")) return "+62" + digits.slice(2);
  if (digits.startsWith("0")) return "+62" + digits.slice(1);
  return "+62" + digits;
}
