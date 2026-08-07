// =============================================================================
// Sales Order Extraction — deterministic, rule-based parser.
//
// Desain: parser INI tidak memanggil vendor AI (tidak ada API key yang bisa
// diandalkan tersedia, dan hasil harus reproducible untuk test). Ia memenuhi
// kontrak terstruktur `ExtractedSalesOrder` dari packages/ai.
//
// Living Knowledge: hanya kosakata bahasa Indonesia UMUM untuk pola order
// (kata kunci "harga", "diskon"/"potongan", "kirim", dan daftar kata satuan
// generik seperti "dus"/"pcs") yang menjadi grammar dasar parser — ini bukan
// data spesifik tenant. Semua yang SPESIFIK tenant (nama produk, kode
// produk, nama/kode customer, alias satuan tambahan) HARUS di-resolve lewat
// KnowledgeContext (lihat knowledge-provider.ts), tidak pernah di-hardcode.
//
// Ambiguity: resolusi alias/nama produk & customer TIDAK PERNAH memilih
// kandidat pertama saat ada lebih dari satu kecocokan berbeda (lihat
// resolveUnique). Nol kandidat -> teks mentah dipertahankan (NOT_FOUND).
// Lebih dari satu kandidat -> teks mentah dipertahankan + ditandai di
// missingFields sebagai *.ambiguous (NEEDS_CLARIFICATION), bukan ditebak.
// =============================================================================

import type { ExtractedSalesOrder, ExtractedSalesOrderItem, DiscountType } from "@flowsales/ai";
import type { KnowledgeContext } from "./types";
import { normalizeAliasKey, parseIndonesianAmount, parseDecimalNumber } from "./normalize";

// Grammar dasar bahasa Indonesia untuk order lisan/tulisan sales — generik,
// bukan pengetahuan spesifik tenant.
const GENERIC_UNIT_WORDS = [
  "dus", "pcs", "pc", "box", "karton", "botol", "galon", "kg", "gram", "gr",
  "liter", "ltr", "lusin", "buah", "unit", "sak", "pack", "pak", "roll", "rol",
];

// Kata kerja umum yang menandai transisi dari "siapa toko/pemesannya" ke
// "apa yang dipesan" dalam SATU kalimat bebas (tidak dipisah baris), mis.
// "Toko Maju minta cat avian putih 5 kaleng". Generik bahasa Indonesia,
// bukan kosakata spesifik tenant.
const ORDER_TRIGGER_VERBS = ["minta", "pesan", "order", "mau", "beli", "tambah", "kirim"];
const TIME_MARKER_WORDS = ["besok", "nanti", "hari ini", "sekarang"];

const CUSTOMER_LINE_PATTERN = /^(?:order\s+)?(.+?)\s*:?\s*$/i;
const DELIVERY_LINE_PATTERN = /\bkirim\b/i;
const HARGA_PATTERN = /\bharga\s+([a-z0-9.,]+(?:\s*(?:ribu|rb|juta|jt))?)/i;
const DISCOUNT_PATTERN = /\b(?:diskon|potongan)\s+([a-z0-9.,%]+(?:\s*(?:ribu|rb|juta|jt))?%?)/i;
const QTY_UNIT_TAIL_PATTERN = new RegExp(
  `^(.*?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${GENERIC_UNIT_WORDS.join("|")}|[a-z]+)\\s*$`,
  "i"
);

// --- Pengenalan toko in-line (satu kalimat, tanpa pemisah baris) ---------
const TRIGGER_VERB_ALTERNATION = ORDER_TRIGGER_VERBS.join("|");
const KIRIM_KE_INLINE_PATTERN = new RegExp(
  `\\bkirim\\s+ke\\s+([a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,4}?)(?=\\s*(?:,|${TIME_MARKER_WORDS.map((w) => w.replace(" ", "\\s+")).join("|")}|$))`,
  "i"
);
const TOKO_INLINE_PATTERN = new RegExp(
  `\\b(toko\\s+[a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,4}?)(?=\\s+(?:${TRIGGER_VERB_ALTERNATION})\\b|\\s*[,:]|$)`,
  "i"
);
const HONORIFIC_INLINE_PATTERN = new RegExp(
  `\\b((?:bu|pak|ibu|bapak)\\s+[a-z][\\w'-]*(?:\\s+[a-z][\\w'-]*){0,2}?)(?=\\s+(?:${TRIGGER_VERB_ALTERNATION})\\b|\\s*[,:]|$)`,
  "i"
);
const LEADING_TRIGGER_VERB_PATTERN = new RegExp(`^\\s*(?:${TRIGGER_VERB_ALTERNATION})\\b\\s*`, "i");
const LEADING_TIME_MARKER_PATTERN = new RegExp(
  `^\\s*(?:${TIME_MARKER_WORDS.map((w) => w.replace(" ", "\\s+")).join("|")})\\b\\s*,?\\s*`,
  "i"
);
const LEADING_COMMA_PATTERN = /^\s*,\s*/;

function splitLines(rawText: string): string[] {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function looksLikeItemLine(line: string): boolean {
  return HARGA_PATTERN.test(line) || QTY_UNIT_TAIL_PATTERN.test(line);
}

interface InlineStoreMarker {
  customerName: string;
  remainder: string;
  deliveryPhrase: string | null;
}

/**
 * Deteksi penanda toko/customer yang menyatu dalam SATU kalimat (bukan baris
 * terpisah), mis. "Toko Maju minta cat avian putih 5 kaleng" atau
 * "Kirim ke sumber jaya besok, nippon merah 3 dus". Hanya dipakai bila sisa
 * teks setelah penanda dilepas MASIH terlihat seperti baris item -- kalau
 * tidak, kembalikan null supaya baris murni nama toko (mis. "Order Toko
 * Sinar Jaya:") tetap ditangani oleh heuristik baris-pertama yang sudah ada
 * (tidak ada regresi pada format existing).
 */
function detectInlineStoreMarker(line: string): InlineStoreMarker | null {
  const kirimMatch = line.match(KIRIM_KE_INLINE_PATTERN);
  if (kirimMatch && kirimMatch[1] && kirimMatch.index !== undefined) {
    const customerName = kirimMatch[1].trim();
    let remainder = line.slice(0, kirimMatch.index) + line.slice(kirimMatch.index + kirimMatch[0].length);
    let deliveryPhrase: string | null = null;
    const timeMatch = remainder.match(LEADING_TIME_MARKER_PATTERN);
    if (timeMatch) {
      deliveryPhrase = timeMatch[0].replace(/[,]/g, "").trim();
      remainder = remainder.slice(timeMatch[0].length);
    }
    remainder = remainder.replace(LEADING_COMMA_PATTERN, "").trim();
    if (customerName.length > 0 && looksLikeItemLine(remainder)) {
      return { customerName, remainder, deliveryPhrase };
    }
  }

  for (const pattern of [TOKO_INLINE_PATTERN, HONORIFIC_INLINE_PATTERN]) {
    const match = line.match(pattern);
    if (!match || !match[1] || match.index === undefined) continue;
    const customerName = match[1].trim();
    let remainder = line.slice(0, match.index) + line.slice(match.index + match[0].length);
    remainder = remainder.replace(LEADING_TRIGGER_VERB_PATTERN, "");
    remainder = remainder.replace(LEADING_COMMA_PATTERN, "").trim();
    if (customerName.length > 0 && looksLikeItemLine(remainder)) {
      return { customerName, remainder, deliveryPhrase: null };
    }
  }

  return null;
}

function parseDiscountPhrase(phrase: string): { type: DiscountType; value: number } | null {
  const trimmed = phrase.trim();
  if (trimmed.includes("%")) {
    const num = parseDecimalNumber(trimmed.replace("%", "").trim());
    if (num === null) return null;
    return { type: "percentage", value: num };
  }
  const nominal = parseIndonesianAmount(trimmed);
  if (nominal === null) return null;
  return { type: "nominal", value: nominal };
}

// Catatan ambiguitas: UNIQUE(company_id, alias_text) di DB mencegah duplikat
// pada string PERSIS sama, tapi normalizeAliasKey() bisa menyatukan dua
// alias_text berbeda (mis. beda spasi/huruf besar-kecil) yang menunjuk
// entitas berbeda -- resolveProductAlias/resolveCustomerCode di bawah
// mengumpulkan SELURUH baris yang cocok (bukan .find() match pertama) dan
// menandai ambigu bila lebih dari satu id berbeda ditemukan.

function resolveProductAlias(
  productNameRaw: string,
  knowledge: KnowledgeContext
): { name: string; code: string | null; ambiguous: boolean } {
  const key = normalizeAliasKey(productNameRaw);
  const matches = knowledge.productAliases.filter((a) => normalizeAliasKey(a.aliasText) === key);
  if (matches.length === 0) return { name: productNameRaw.trim(), code: null, ambiguous: false };

  // Alias yang cocok tapi menunjuk PRODUK BERBEDA (productId berbeda) -> ambigu,
  // meski secara kebetulan nama/kode kanoniknya sama untuk sebagian baris.
  const distinctProductIds = new Set(matches.map((a) => a.productId));
  if (distinctProductIds.size > 1) {
    return { name: productNameRaw.trim(), code: null, ambiguous: true };
  }
  const match = matches[0]!;
  return { name: match.productName, code: match.productCode, ambiguous: false };
}

// Gate 3E-D4-C7 (Temuan #4): sinonim satuan bahasa Indonesia UMUM (bukan
// data spesifik tenant, pola sama dengan GENERIC_UNIT_WORDS/parseIndonesianAmount
// "ribu"/"juta") -- normalisasi deterministic (kamus tetap, bukan
// similarity score), dipakai HANYA sebagai fallback SETELAH knowledge_unit_
// aliases spesifik-tenant tidak menemukan kecocokan. Tidak menebak satuan
// yang tidak dikenali sama sekali -- teks mentah tetap dipertahankan.
const GENERIC_UNIT_SYNONYMS: Record<string, string> = {
  kilo: "kg",
  kilogram: "kg",
  kilogr: "kg",
  liter: "ltr",
  literan: "ltr",
};

function resolveUnitAlias(unitRaw: string, knowledge: KnowledgeContext): string {
  const key = normalizeAliasKey(unitRaw);
  const match = knowledge.unitAliases.find((a) => normalizeAliasKey(a.aliasText) === key);
  if (match) return match.canonicalUnit;
  return GENERIC_UNIT_SYNONYMS[key] ?? unitRaw.trim();
}

function parseItemLine(
  line: string,
  knowledge: KnowledgeContext
): { item: ExtractedSalesOrderItem; missing: string[]; productAmbiguous: boolean } | null {
  let working = line;

  // 1. Diskon (di akhir kalimat, opsional)
  let discountType: DiscountType | null = null;
  let discountValue: number | null = null;
  const discountMatch = working.match(DISCOUNT_PATTERN);
  if (discountMatch) {
    const parsed = parseDiscountPhrase(discountMatch[1]!);
    if (parsed) {
      discountType = parsed.type;
      discountValue = parsed.value;
    }
    working = working.slice(0, discountMatch.index).trim();
  }

  // 2. Harga -- OPSIONAL. Sales lapangan sering tidak menyebut harga sama
  // sekali (harga disepakati/di-lookup terpisah); tidak ada harga bukan
  // berarti bukan order, hanya berarti unitPrice belum diketahui (masuk
  // missingFields, TIDAK diberi default diam-diam di sini -- lihat pricing.ts
  // untuk bagaimana null ditangani saat kalkulasi subtotal).
  let unitPrice: number | null = null;
  const hargaMatch = working.match(HARGA_PATTERN);
  if (hargaMatch) {
    unitPrice = parseIndonesianAmount(hargaMatch[1]!);
    working = working.slice(0, hargaMatch.index).trim();
  }

  // 3. Qty + satuan di ekor sisa teks, sisanya nama produk
  const qtyMatch = working.match(QTY_UNIT_TAIL_PATTERN);
  let productNameRaw: string;
  let quantity: number | null = null;
  let unitRaw: string | null = null;
  if (qtyMatch) {
    productNameRaw = qtyMatch[1]!.trim();
    quantity = parseDecimalNumber(qtyMatch[2]!);
    unitRaw = qtyMatch[3]!.trim();
  } else {
    productNameRaw = working.trim();
  }

  if (productNameRaw.length === 0) return null;
  // Baris tanpa harga DAN tanpa qty+satuan yang jelas tidak cukup terlihat
  // seperti item order (looksLikeItemLine sudah memfilter di pemanggil,
  // guard ini hanya untuk parseItemLine yang dipanggil langsung).
  if (!hargaMatch && !qtyMatch) return null;

  const resolvedProduct = resolveProductAlias(productNameRaw, knowledge);
  const unit = unitRaw ? resolveUnitAlias(unitRaw, knowledge) : null;

  const missing: string[] = [];
  if (quantity === null) missing.push("quantity");
  if (unit === null) missing.push("unit");
  if (unitPrice === null) missing.push("unitPrice");
  if (resolvedProduct.ambiguous) missing.push("productName.ambiguous");

  const subtotal =
    quantity !== null && unitPrice !== null
      ? computeItemSubtotal(quantity, unitPrice, discountType, discountValue)
      : null;

  return {
    item: {
      productName: resolvedProduct.name,
      productCode: resolvedProduct.code,
      quantity,
      unit,
      unitPrice,
      discountType,
      discountValue,
      subtotal,
    },
    missing,
    productAmbiguous: resolvedProduct.ambiguous,
  };
}

function computeItemSubtotal(
  quantity: number,
  unitPrice: number,
  discountType: DiscountType | null,
  discountValue: number | null
): number {
  const gross = quantity * unitPrice;
  if (!discountType || discountValue === null) return gross;
  const discountAmount = discountType === "percentage" ? gross * (discountValue / 100) : discountValue;
  return Math.max(0, gross - discountAmount);
}

/**
 * Ekstraksi deterministik dari teks pesan Telegram menjadi ExtractedSalesOrder.
 * Tidak pernah melempar exception untuk input yang tidak valid — selalu
 * mengembalikan struktur dengan confidence rendah + missingFields.
 */
export function extractSalesOrder(rawText: string, knowledge: KnowledgeContext): ExtractedSalesOrder {
  const lines = splitLines(rawText);
  const missingFields: string[] = [];

  let deliveryNote: string | null = null;
  let inlineCustomerCandidate: string | null = null;
  const nonDeliveryLines: string[] = [];
  for (const line of lines) {
    const marker = detectInlineStoreMarker(line);
    if (marker) {
      if (inlineCustomerCandidate === null) inlineCustomerCandidate = marker.customerName;
      if (marker.deliveryPhrase) deliveryNote = marker.deliveryPhrase;
      nonDeliveryLines.push(marker.remainder);
      continue;
    }
    if (DELIVERY_LINE_PATTERN.test(line)) {
      const withoutKeyword = line.replace(/^kirim\s*/i, "").trim();
      deliveryNote = withoutKeyword.length > 0 ? withoutKeyword : line;
    } else {
      nonDeliveryLines.push(line);
    }
  }

  let customerName: string | null = null;
  let itemLines = nonDeliveryLines;
  if (nonDeliveryLines.length > 0 && !looksLikeItemLine(nonDeliveryLines[0]!)) {
    const customerMatch = nonDeliveryLines[0]!.match(CUSTOMER_LINE_PATTERN);
    if (customerMatch && customerMatch[1] && customerMatch[1].trim().length > 0) {
      customerName = customerMatch[1].trim();
    }
    itemLines = nonDeliveryLines.slice(1);
  }

  if (customerName === null && inlineCustomerCandidate !== null) {
    customerName = inlineCustomerCandidate;
  }

  if (customerName === null) missingFields.push("customer.name");

  const items: ExtractedSalesOrderItem[] = [];
  for (const line of itemLines) {
    if (!looksLikeItemLine(line)) continue; // baris lain (mis. noise) diabaikan
    const parsed = parseItemLine(line, knowledge);
    if (!parsed) continue;
    items.push(parsed.item);
    parsed.missing.forEach((m) => missingFields.push(`items[${items.length - 1}].${m}`));
  }

  if (deliveryNote === null) missingFields.push("deliveryNote");

  const customerResolution = resolveCustomerCode(customerName, knowledge);
  if (customerResolution.ambiguous) missingFields.push("customer.ambiguous");

  const confidence = computeConfidence(customerName, items, missingFields);

  return {
    customer: { name: customerName, code: customerResolution.code },
    items,
    deliveryNote,
    missingFields,
    confidence,
  };
}

function resolveCustomerCode(
  customerName: string | null,
  knowledge: KnowledgeContext
): { code: string | null; ambiguous: boolean } {
  if (!customerName) return { code: null, ambiguous: false };
  const key = normalizeAliasKey(customerName);
  const matches = knowledge.customerAliases.filter((a) => normalizeAliasKey(a.aliasText) === key);
  if (matches.length === 0) return { code: null, ambiguous: false };

  const distinctCustomerIds = new Set(matches.map((a) => a.customerId));
  if (distinctCustomerIds.size > 1) return { code: null, ambiguous: true };
  return { code: matches[0]!.customerCode, ambiguous: false };
}

function computeConfidence(
  customerName: string | null,
  items: ExtractedSalesOrderItem[],
  missingFields: string[]
): number {
  if (items.length === 0) return 0;

  let score = 1;
  if (customerName === null) score -= 0.2;
  const itemFieldIssues = missingFields.filter((f) => f.startsWith("items[")).length;
  score -= Math.min(0.6, itemFieldIssues * 0.15);

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/** Pesan dianggap "bukan order" jika tidak ada satu pun item yang berhasil diekstrak. */
export function isLikelyOrderMessage(extracted: ExtractedSalesOrder): boolean {
  return extracted.items.length > 0;
}
