// =============================================================================
// Pricing — menggabungkan ExtractedSalesOrder + KnowledgeContext menjadi
// PricedOrder: subtotal, diskon, estimasi total per item & order, plus
// resolusi productId/customerId dari Knowledge Pack (bukan hardcode).
// =============================================================================

import type { ExtractedSalesOrder } from "@flowsales/ai";
import type { KnowledgeContext, PricedOrder, PricedOrderItem } from "./types";
import { evaluateItemDiscount, findApplicablePolicy } from "./discount";
import { normalizeAliasKey } from "./normalize";

interface ResolvedRef {
  id: string | null;
  /** TRUE bila teks mentah cocok dengan LEBIH DARI SATU entitas berbeda -- id sengaja null, tidak boleh menebak salah satu. */
  ambiguous: boolean;
}

/**
 * Kumpulkan SELURUH kandidat id yang cocok (bukan .find() match pertama).
 * Nol kandidat -> NOT_FOUND (id null, ambiguous false). Satu kandidat unik
 * -> resolve normal. Lebih dari satu id BERBEDA -> AMBIGUOUS (id null,
 * ambiguous true) -- kontrak gate parser: toko/produk ambigu tidak boleh
 * ditebak, jangan pernah memilih kandidat pertama.
 */
function resolveUnique(candidateIds: string[]): ResolvedRef {
  const distinct = Array.from(new Set(candidateIds));
  if (distinct.length === 0) return { id: null, ambiguous: false };
  if (distinct.length === 1) return { id: distinct[0]!, ambiguous: false };
  return { id: null, ambiguous: true };
}

function resolveProductId(
  productName: string,
  productCode: string | null,
  knowledge: KnowledgeContext
): ResolvedRef {
  if (productCode) {
    // productCode berasal dari alias unik (UNIQUE company_id+alias_text di DB) yang sudah
    // di-resolve di extraction.ts -- products.sku juga unik per company, jadi lookup by-code
    // tidak pernah ambigu secara struktural. Tetap dikumpulkan via resolveUnique untuk konsistensi.
    const byCode = knowledge.productAliases
      .filter((a) => a.productCode === productCode)
      .map((a) => a.productId);
    const resolved = resolveUnique(byCode);
    if (resolved.id !== null) return resolved;
  }
  // Fallback: cocokkan teks mentah terhadap NAMA KANONIK produk atau alias_text.
  // products.name TIDAK unique per company (hanya sku) -- dua produk berbeda BISA
  // punya nama yang identik setelah normalisasi, jadi wajib dikumpulkan semua kandidat.
  const key = normalizeAliasKey(productName);
  const byName = knowledge.productAliases
    .filter((a) => normalizeAliasKey(a.productName) === key || normalizeAliasKey(a.aliasText) === key)
    .map((a) => a.productId);
  return resolveUnique(byName);
}

function resolveCustomerId(customerName: string | null, knowledge: KnowledgeContext): ResolvedRef {
  if (!customerName) return { id: null, ambiguous: false };
  // customers.name TIDAK unique per company (hanya code) -- dua toko berbeda BISA
  // bernama sama, jadi wajib dikumpulkan semua kandidat, bukan .find() match pertama.
  const key = normalizeAliasKey(customerName);
  const matches = knowledge.customerAliases
    .filter((a) => normalizeAliasKey(a.customerName) === key || normalizeAliasKey(a.aliasText) === key)
    .map((a) => a.customerId);
  return resolveUnique(matches);
}

export function buildPricedOrder(extracted: ExtractedSalesOrder, knowledge: KnowledgeContext): PricedOrder {
  const customerResolved = resolveCustomerId(extracted.customer.name, knowledge);
  const customerId = customerResolved.id;

  const items: PricedOrderItem[] = extracted.items.map((item) => {
    const productResolved = resolveProductId(item.productName, item.productCode, knowledge);
    const productId = productResolved.id;
    const quantity = item.quantity ?? 0;
    const unitPrice = item.unitPrice ?? 0;

    const policy = findApplicablePolicy(knowledge.discountPolicies, productId, customerId);
    const evaluation = evaluateItemDiscount(quantity, unitPrice, item.discountType, item.discountValue, policy);

    return {
      productName: item.productName,
      productCode: item.productCode,
      productId,
      productAmbiguous: productResolved.ambiguous,
      quantity,
      unit: item.unit,
      unitPrice,
      discountType: item.discountType,
      discountValue: item.discountValue,
      amountBeforeDiscount: evaluation.amountBeforeDiscount,
      amountAfterDiscount: evaluation.amountAfterDiscount,
      discountException: evaluation.discountException,
      requiresReview: evaluation.requiresReview,
    };
  });

  const subtotal = items.reduce((s, i) => s + i.amountBeforeDiscount, 0);
  const estimatedTotal = items.reduce((s, i) => s + i.amountAfterDiscount, 0);
  const totalDiscount = subtotal - estimatedTotal;
  const requiresDiscountReview = items.some((i) => i.requiresReview);

  return {
    customerName: extracted.customer.name,
    customerId,
    customerAmbiguous: customerResolved.ambiguous,
    items,
    subtotal,
    totalDiscount,
    estimatedTotal,
    requiresDiscountReview,
    deliveryNote: extracted.deliveryNote,
  };
}
