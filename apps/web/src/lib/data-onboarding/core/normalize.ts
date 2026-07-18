// =============================================================================
// Universal Data Onboarding Core — normalisasi format teks generik (locale
// id-ID). Primitif FORMAT murni (tanggal/nominal/boolean/teks), bukan schema
// bisnis apa pun -- aman dipakai domain/tenant mana saja.
// =============================================================================

/**
 * Tanggal Indonesia deterministik: DD/MM/YYYY, DD-MM-YYYY, atau YYYY-MM-DD
 * (ISO). Format ambigu (mis. "01/02/2026") SELALU dibaca DD/MM/YYYY
 * (konvensi Indonesia). Return null jika tidak bisa diparse (bukan ditebak).
 */
export function normalizeIdDate(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return isValidDateParts(Number(y), Number(m), Number(d)) ? `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}` : null;
  }

  const dmy = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return isValidDateParts(Number(y), Number(m), Number(d)) ? `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}` : null;
  }

  return null;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Nominal Indonesia: "Rp 1.500.000", "1.500.000,50", "1500000" -> 1500000(.5).
 * Titik = pemisah ribuan, koma = desimal. Return null jika tidak bisa
 * diparse sebagai angka (bukan default ke 0).
 */
export function normalizeIdCurrency(raw: string | null | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  let cleaned = raw.trim().replace(/^Rp\.?\s*/i, "").replace(/\s/g, "");
  const isNegative = /^-/.test(cleaned) || /^\(.*\)$/.test(cleaned);
  cleaned = cleaned.replace(/^[-(]|\)$/g, "");

  const hasDecimalComma = /,\d{1,2}$/.test(cleaned);
  if (hasDecimalComma) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    cleaned = cleaned.replace(/[.,]/g, "");
  }

  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return isNegative ? -n : n;
}

export function normalizeIdNumber(raw: string | null | undefined): number | null {
  return normalizeIdCurrency(raw);
}

export function normalizeUpperSlug(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  return raw.trim().toUpperCase().replace(/\s+/g, "-");
}

const TRUE_VALUES = new Set(["true", "1", "ya", "yes", "aktif", "active"]);
const FALSE_VALUES = new Set(["false", "0", "tidak", "no", "nonaktif", "inactive"]);

export function normalizeBoolean(raw: string | null | undefined, defaultValue = true): boolean {
  if (!raw || raw.trim() === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return defaultValue;
}
