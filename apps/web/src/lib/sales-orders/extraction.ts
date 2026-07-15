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

const CUSTOMER_LINE_PATTERN = /^(?:order\s+)?(.+?)\s*:?\s*$/i;
const DELIVERY_LINE_PATTERN = /\bkirim\b/i;
const HARGA_PATTERN = /\bharga\s+([a-z0-9.,]+(?:\s*(?:ribu|rb|juta|jt))?)/i;
const DISCOUNT_PATTERN = /\b(?:diskon|potongan)\s+([a-z0-9.,%]+(?:\s*(?:ribu|rb|juta|jt))?%?)/i;
const QTY_UNIT_TAIL_PATTERN = new RegExp(
  `^(.*?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${GENERIC_UNIT_WORDS.join("|")}|[a-z]+)\\s*$`,
  "i"
);

function splitLines(rawText: string): string[] {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function looksLikeItemLine(line: string): boolean {
  return HARGA_PATTERN.test(line);
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

function resolveProductAlias(
  productNameRaw: string,
  knowledge: KnowledgeContext
): { name: string; code: string | null } {
  const key = normalizeAliasKey(productNameRaw);
  const match = knowledge.productAliases.find((a) => normalizeAliasKey(a.aliasText) === key);
  if (match) return { name: match.productName, code: match.productCode };
  return { name: productNameRaw.trim(), code: null };
}

function resolveUnitAlias(unitRaw: string, knowledge: KnowledgeContext): string {
  const key = normalizeAliasKey(unitRaw);
  const match = knowledge.unitAliases.find((a) => normalizeAliasKey(a.aliasText) === key);
  return match ? match.canonicalUnit : unitRaw.trim();
}

function parseItemLine(
  line: string,
  knowledge: KnowledgeContext
): { item: ExtractedSalesOrderItem; missing: string[] } | null {
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

  // 2. Harga
  let unitPrice: number | null = null;
  const hargaMatch = working.match(HARGA_PATTERN);
  if (!hargaMatch) return null; // bukan baris item yang valid
  unitPrice = parseIndonesianAmount(hargaMatch[1]!);
  working = working.slice(0, hargaMatch.index).trim();

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

  const resolvedProduct = resolveProductAlias(productNameRaw, knowledge);
  const unit = unitRaw ? resolveUnitAlias(unitRaw, knowledge) : null;

  const missing: string[] = [];
  if (quantity === null) missing.push("quantity");
  if (unit === null) missing.push("unit");
  if (unitPrice === null) missing.push("unitPrice");

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
  const nonDeliveryLines: string[] = [];
  for (const line of lines) {
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

  const confidence = computeConfidence(customerName, items, missingFields);

  return {
    customer: { name: customerName, code: resolveCustomerCode(customerName, knowledge) },
    items,
    deliveryNote,
    missingFields,
    confidence,
  };
}

function resolveCustomerCode(customerName: string | null, knowledge: KnowledgeContext): string | null {
  if (!customerName) return null;
  const key = normalizeAliasKey(customerName);
  const match = knowledge.customerAliases.find((a) => normalizeAliasKey(a.aliasText) === key);
  return match ? match.customerCode : null;
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
