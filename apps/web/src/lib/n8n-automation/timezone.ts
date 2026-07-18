// =============================================================================
// Business timezone helper -- Asia/Jakarta (WIB, UTC+7 tetap, tanpa DST).
//
// Wajib dipakai untuk SEMUA business-date/scheduling di modul automation
// (Morning Brief jam 07:00 WIB, idempotency key per business date). Memakai
// Intl.DateTimeFormat dengan timeZone eksplisit (bukan offset manual +7)
// supaya benar terhadap ICU tanpa dependency tambahan -- Node modern sudah
// membundel ICU penuh.
//
// Modul lain (mis. lib/sales-kpi/service.ts todayIsoDate()) masih memakai
// kalender UTC apa adanya -- itu keputusan/limitation TERPISAH yang sudah
// didokumentasikan di gate sebelumnya, TIDAK diubah oleh file ini (di luar
// scope phase n8n). Helper ini HANYA dipakai kode automation baru.
// =============================================================================

export const AODP_BUSINESS_TIMEZONE = "Asia/Jakarta";

/** YYYY-MM-DD di Asia/Jakarta untuk `date` (default: sekarang). */
export function businessDateJakarta(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AODP_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Jam:menit di Asia/Jakarta (format 24 jam) untuk `date` (default: sekarang). */
export function jakartaHourMinute(date: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: AODP_BUSINESS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}
