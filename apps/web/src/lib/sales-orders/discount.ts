// =============================================================================
// Discount control — pure functions, no I/O.
//
// Aturan wajib (task spec):
// - Diskon disimpan per item, nilai sebelum & sesudah diskon.
// - Jika diskon melebihi knowledge_discount_policies yang berlaku -> discount_exception.
// - Jika TIDAK ADA policy yang berlaku sama sekali -> requiresReview = true.
//   Jangan pernah mengarang limit default.
// =============================================================================

import type { DiscountType, DiscountPolicyKnowledge, DiscountEvaluation } from "./types";

export function findApplicablePolicy(
  policies: DiscountPolicyKnowledge[],
  productId: string | null,
  customerId: string | null
): DiscountPolicyKnowledge | null {
  // Prioritas: policy spesifik produk > spesifik customer > global.
  if (productId) {
    const productPolicy = policies.find((p) => p.scope === "product" && p.productId === productId);
    if (productPolicy) return productPolicy;
  }
  if (customerId) {
    const customerPolicy = policies.find((p) => p.scope === "customer" && p.customerId === customerId);
    if (customerPolicy) return customerPolicy;
  }
  const globalPolicy = policies.find((p) => p.scope === "global");
  return globalPolicy ?? null;
}

export function evaluateItemDiscount(
  quantity: number,
  unitPrice: number,
  discountType: DiscountType | null,
  discountValue: number | null,
  policy: DiscountPolicyKnowledge | null
): DiscountEvaluation {
  const amountBeforeDiscount = quantity * unitPrice;

  if (!discountType || discountValue === null || discountValue === undefined) {
    return {
      amountBeforeDiscount,
      amountAfterDiscount: amountBeforeDiscount,
      discountException: false,
      requiresReview: false,
    };
  }

  const discountAmount =
    discountType === "percentage"
      ? amountBeforeDiscount * (discountValue / 100)
      : discountValue;

  const amountAfterDiscount = Math.max(0, amountBeforeDiscount - discountAmount);

  // Tidak ada policy berlaku sama sekali -> limit tidak diketahui, wajib review.
  if (!policy) {
    return { amountBeforeDiscount, amountAfterDiscount, discountException: false, requiresReview: true };
  }

  let discountException = false;
  if (discountType === "percentage" && policy.maxPercentage !== null) {
    discountException = discountValue > policy.maxPercentage;
  } else if (discountType === "nominal" && policy.maxNominal !== null) {
    discountException = discountValue > policy.maxNominal;
  } else {
    // Policy ada tapi tidak mendefinisikan limit untuk tipe diskon ini -> tetap review.
    return { amountBeforeDiscount, amountAfterDiscount, discountException: false, requiresReview: true };
  }

  return {
    amountBeforeDiscount,
    amountAfterDiscount,
    discountException,
    // Melebihi limit tetap wajib direview manusia, bukan otomatis ditolak.
    requiresReview: discountException,
  };
}
