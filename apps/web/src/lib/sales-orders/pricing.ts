// =============================================================================
// Pricing — menggabungkan ExtractedSalesOrder + KnowledgeContext menjadi
// PricedOrder: subtotal, diskon, estimasi total per item & order, plus
// resolusi productId/customerId dari Knowledge Pack (bukan hardcode).
// =============================================================================

import type { ExtractedSalesOrder } from "@flowsales/ai";
import type { KnowledgeContext, PricedOrder, PricedOrderItem } from "./types";
import { evaluateItemDiscount, findApplicablePolicy } from "./discount";
import { normalizeAliasKey } from "./normalize";

function resolveProductId(
  productName: string,
  productCode: string | null,
  knowledge: KnowledgeContext
): string | null {
  if (productCode) {
    const byCode = knowledge.productAliases.find((a) => a.productCode === productCode);
    if (byCode) return byCode.productId;
  }
  const key = normalizeAliasKey(productName);
  const byName = knowledge.productAliases.find(
    (a) => normalizeAliasKey(a.productName) === key || normalizeAliasKey(a.aliasText) === key
  );
  return byName ? byName.productId : null;
}

function resolveCustomerId(customerName: string | null, knowledge: KnowledgeContext): string | null {
  if (!customerName) return null;
  const key = normalizeAliasKey(customerName);
  const match = knowledge.customerAliases.find(
    (a) => normalizeAliasKey(a.customerName) === key || normalizeAliasKey(a.aliasText) === key
  );
  return match ? match.customerId : null;
}

export function buildPricedOrder(extracted: ExtractedSalesOrder, knowledge: KnowledgeContext): PricedOrder {
  const customerId = resolveCustomerId(extracted.customer.name, knowledge);

  const items: PricedOrderItem[] = extracted.items.map((item) => {
    const productId = resolveProductId(item.productName, item.productCode, knowledge);
    const quantity = item.quantity ?? 0;
    const unitPrice = item.unitPrice ?? 0;

    const policy = findApplicablePolicy(knowledge.discountPolicies, productId, customerId);
    const evaluation = evaluateItemDiscount(quantity, unitPrice, item.discountType, item.discountValue, policy);

    return {
      productName: item.productName,
      productCode: item.productCode,
      productId,
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
    items,
    subtotal,
    totalDiscount,
    estimatedTotal,
    requiresDiscountReview,
    deliveryNote: extracted.deliveryNote,
  };
}
