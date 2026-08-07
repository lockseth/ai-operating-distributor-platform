// =============================================================================
// Pricing — menggabungkan ExtractedSalesOrder + KnowledgeContext menjadi
// PricedOrder: subtotal, diskon, estimasi total per item & order, plus
// resolusi productId/customerId dari Knowledge Pack (bukan hardcode).
// =============================================================================

import type { ExtractedSalesOrder } from "@flowsales/ai";
import type { KnowledgeContext, PricedOrder, PricedOrderItem } from "./types";
import { evaluateItemDiscount, findApplicablePolicy } from "./discount";
import { normalizeAliasKey, containsAllWords } from "./normalize";

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

/**
 * Gate 3E-D4-C7 (Temuan #4 -- field-language parsing): saat exact alias-
 * match TIDAK menghasilkan kandidat sama sekali, coba fallback deterministic
 * word-containment terhadap katalog KANONIK (knowledge.products/customers,
 * langsung dari tabel master -- bukan hanya produk/customer yang SUDAH
 * punya alias terpublikasi). "Warna Jaya" -> "Toko Warna Jaya Bangunan",
 * "cat exterior" -> "Cat Tembok Exterior 20 Kg" -- SELURUH kata di teks
 * Sales harus muncul di nama kanonik (containsAllWords, bukan similarity
 * score/typo-tolerant). SELURUH kandidat yang cocok dikumpulkan (bukan
 * .find() match pertama) -- resolveUnique tetap satu-satunya yang boleh
 * memutuskan "resolve" vs "ambiguous", fungsi ini hanya memperluas SUMBER
 * kandidat, tidak pernah menebak.
 */
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
  // Fallback #1 (exact): cocokkan teks mentah terhadap NAMA KANONIK produk atau alias_text.
  // products.name TIDAK unique per company (hanya sku) -- dua produk berbeda BISA
  // punya nama yang identik setelah normalisasi, jadi wajib dikumpulkan semua kandidat.
  const key = normalizeAliasKey(productName);
  const byName = knowledge.productAliases
    .filter((a) => normalizeAliasKey(a.productName) === key || normalizeAliasKey(a.aliasText) === key)
    .map((a) => a.productId);
  const exactResolved = resolveUnique(byName);
  if (exactResolved.id !== null || exactResolved.ambiguous) return exactResolved;

  // Fallback #2 (word-containment, hanya jika exact 0 kandidat): lihat komentar di atas fungsi.
  const byContainment = knowledge.products
    .filter((p) => containsAllWords(productName, p.productName))
    .map((p) => p.productId);
  return resolveUnique(byContainment);
}

function resolveCustomerId(customerName: string | null, knowledge: KnowledgeContext): ResolvedRef {
  if (!customerName) return { id: null, ambiguous: false };
  // customers.name TIDAK unique per company (hanya code) -- dua toko berbeda BISA
  // bernama sama, jadi wajib dikumpulkan semua kandidat, bukan .find() match pertama.
  const key = normalizeAliasKey(customerName);
  const matches = knowledge.customerAliases
    .filter((a) => normalizeAliasKey(a.customerName) === key || normalizeAliasKey(a.aliasText) === key)
    .map((a) => a.customerId);
  const exactResolved = resolveUnique(matches);
  if (exactResolved.id !== null || exactResolved.ambiguous) return exactResolved;

  // Fallback word-containment (Temuan #4) -- lihat komentar di resolveProductId.
  const byContainment = knowledge.customers
    .filter((c) => containsAllWords(customerName, c.customerName))
    .map((c) => c.customerId);
  return resolveUnique(byContainment);
}

export function buildPricedOrder(extracted: ExtractedSalesOrder, knowledge: KnowledgeContext): PricedOrder {
  const customerResolved = resolveCustomerId(extracted.customer.name, knowledge);
  const customerId = customerResolved.id;

  const items: PricedOrderItem[] = extracted.items.map((item) => {
    const productResolved = resolveProductId(item.productName, item.productCode, knowledge);
    const productId = productResolved.id;
    const quantity = item.quantity ?? 0;

    // Gate 3E-D4-C7: harga TIDAK PERNAH lagi diambil dari teks Telegram/
    // parser (item.unitPrice, field opsional hasil parsing "harga X") --
    // satu-satunya sumber adalah harga master (knowledge.products), dan
    // HANYA dipakai bila productId resolve unik ke produk aktif dengan
    // harga > 0. Produk tidak resolve/ambigu/inactive/harga tidak valid
    // sengaja tetap unitPrice=0 di sini -- order akan DITOLAK server-side
    // (create_draft_sales_order_atomic/update_draft_sales_order_atomic,
    // migration 20260929000001) sebelum ringkasan dgn nilai ini pernah
    // dikirim ke sales (lihat workflow.ts: buildConfirmationSummary hanya
    // dipanggil SETELAH createDraftOrder berhasil).
    const masterProduct = productId ? knowledge.products.find((p) => p.productId === productId) : undefined;
    const unitPrice = masterProduct && masterProduct.isActive && masterProduct.price > 0 ? masterProduct.price : 0;

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
