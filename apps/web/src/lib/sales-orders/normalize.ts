// =============================================================================
// Text/number normalization utilities — Sales Order Telegram intake.
// Pure functions, no I/O, fully unit-testable.
// =============================================================================

/** Lowercase + collapse whitespace + trim — dipakai untuk pencocokan alias. */
export function normalizeAliasKey(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Kata utuh, tanda baca penempel (koma/titik/titik dua/dll) dilepas -- BUKAN pelonggaran ejaan per-huruf. */
function wordSet(text: string): Set<string> {
  return new Set(
    normalizeAliasKey(text)
      .split(" ")
      .map((w) => w.replace(/^[.,:;!?()"'`-]+|[.,:;!?()"'`-]+$/g, ""))
      .filter((w) => w.length > 0),
  );
}

function isWordSubset(small: Set<string>, big: Set<string>): boolean {
  for (const w of small) {
    if (!big.has(w)) return false;
  }
  return true;
}

/**
 * Gate 3E-D4-C7 (Temuan #4 -- field-language parsing): TRUE bila kata-kata
 * `a` adalah SUBSET dari kata-kata `b` ATAU sebaliknya (urutan/posisi bebas,
 * tanda baca penempel diabaikan) -- bukan substring berurutan, bukan
 * similarity score/typo-tolerant. Dua arah SENGAJA didukung: sales sering
 * menyingkat ("Warna Jaya" utk "Toko Warna Jaya Bangunan" -- teks lebih
 * PENDEK dari master) tapi kadang juga menambah konteks ("Toko Baru, repeat
 * order" -- teks lebih PANJANG dari master "Toko Baru"). Deterministic
 * murni -- dipakai HANYA sebagai fallback SAAT exact alias-match gagal (0
 * kandidat). Uniqueness (hanya boleh resolve bila SATU kandidat berbeda)
 * WAJIB tetap diperiksa terpisah oleh pemanggil (resolveUnique) -- fungsi
 * ini hanya predikat kecocokan per-kandidat, bukan pemilih kandidat.
 */
export function containsAllWords(a: string, b: string): boolean {
  const wordsA = wordSet(a);
  const wordsB = wordSet(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  return isWordSubset(wordsA, wordsB) || isWordSubset(wordsB, wordsA);
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

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep(record[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * JSON.stringify dengan key object diurutkan secara rekursif — dipakai untuk
 * membandingkan dua payload Telegram (mis. update_id sama, cek konflik
 * payload di workflow.ts) tanpa false-positive akibat urutan key JSONB yang
 * tidak dijamin sama dengan urutan asli saat pulang-pergi lewat Postgres.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
