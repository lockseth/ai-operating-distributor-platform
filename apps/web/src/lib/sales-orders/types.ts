// =============================================================================
// Internal types — Sales Order Telegram intake module.
// =============================================================================

export type { ExtractedSalesOrder, ExtractedSalesOrderItem, DiscountType } from "@flowsales/ai";

/** Satu baris alias/kebijakan dari Knowledge Pack — Published Knowledge saja. */
export interface ProductAliasKnowledge {
  aliasText: string;
  productId: string;
  productName: string;
  productCode: string | null;
  updatedAt: string;
}

export interface CustomerAliasKnowledge {
  aliasText: string;
  customerId: string;
  customerName: string;
  customerCode: string | null;
  updatedAt: string;
}

export interface UnitAliasKnowledge {
  aliasText: string;
  canonicalUnit: string;
  updatedAt: string;
}

export interface DiscountPolicyKnowledge {
  scope: "global" | "product" | "customer";
  productId: string | null;
  customerId: string | null;
  maxPercentage: number | null;
  maxNominal: number | null;
  updatedAt: string;
}

/** Snapshot Knowledge Pack aktif satu company — dipakai sekali per ekstraksi. */
export interface KnowledgeContext {
  companyId: string;
  productAliases: ProductAliasKnowledge[];
  customerAliases: CustomerAliasKnowledge[];
  unitAliases: UnitAliasKnowledge[];
  discountPolicies: DiscountPolicyKnowledge[];
  /** String teraudit: dipakai untuk sales_orders.knowledge_version. */
  knowledgeVersion: string;
}

export interface DiscountEvaluation {
  amountBeforeDiscount: number;
  amountAfterDiscount: number;
  /** TRUE jika diskon melebihi knowledge_discount_policies yang berlaku */
  discountException: boolean;
  /** TRUE jika tidak ada policy yang berlaku sama sekali (limit tidak diketahui) */
  requiresReview: boolean;
}

export interface PricedOrderItem {
  productName: string;
  productCode: string | null;
  productId: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  discountType: "percentage" | "nominal" | null;
  discountValue: number | null;
  amountBeforeDiscount: number;
  amountAfterDiscount: number;
  discountException: boolean;
  requiresReview: boolean;
}

export interface PricedOrder {
  customerName: string | null;
  customerId: string | null;
  items: PricedOrderItem[];
  subtotal: number;
  totalDiscount: number;
  estimatedTotal: number;
  requiresDiscountReview: boolean;
  deliveryNote: string | null;
}
