// =============================================================================
// Text/number normalization utilities — Sales Order Telegram intake.
// Pure functions, no I/O, fully unit-testable.
// =============================================================================

/** Lowercase + collapse whitespace + trim — dipakai untuk pencocokan alias. */
export function normalizeAliasKey(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Parse angka Rupiah dalam gaya penulisan bebas orang Indonesia:
 * "450000", "450.000", "450,000", "450 ribu", "1.5 juta", "Rp450rb", dst.
 * Mengembalikan null jika tidak bisa diparse — jangan pernah menebak.
 */
export function parseIndonesianAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  text = text.replace(/^rp\.?\s*/i, "").trim();

  // Tangkap pengali kata (ribu/rb, juta/jt) di akhir teks
  let multiplier = 1;
  const multiplierMatch = text.match(/(ribu|rb|juta|jt)\s*$/i);
  if (multiplierMatch) {
    const word = multiplierMatch[1]!.toLowerCase();
    multiplier = word.startsWith("j") ? 1_000_000 : 1_000;
    text = text.slice(0, multiplierMatch.index).trim();
  }

  if (text.length === 0) return null;

  // Angka dengan titik/koma sebagai pemisah ribuan ATAU desimal.
  // Heuristik: jika ada pengali kata (ribu/juta), koma/titik dianggap desimal.
  // Jika tidak ada pengali, titik/koma dianggap pemisah ribuan (gaya ID).
  let numeric: number;
  if (multiplier > 1) {
    const decimalNormalized = text.replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(decimalNormalized)) return null;
    numeric = parseFloat(decimalNormalized);
  } else {
    const stripped = text.replace(/[.,]/g, "");
    if (!/^\d+$/.test(stripped)) return null;
    numeric = parseInt(stripped, 10);
  }

  if (Number.isNaN(numeric)) return null;
  return Math.round(numeric * multiplier);
}

/** Parse angka desimal biasa (mis. quantity "2,5" atau "2.5") — tanpa pengali kata. */
export function parseDecimalNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = parseFloat(text);
  return Number.isNaN(n) ? null : n;
}

/** Rupiah formatter untuk ringkasan konfirmasi — "Rp8.550.000" */
export function formatIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}
