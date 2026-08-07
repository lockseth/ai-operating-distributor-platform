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

/**
 * Gate 3E-D4-C7: katalog KANONIK produk (langsung dari tabel products,
 * TERPISAH dari ProductAliasKnowledge yang hanya memuat produk yang SUDAH
 * punya alias terpublikasi) -- dipakai pricing.ts untuk dua hal: (1) harga
 * master (MENGGANTIKAN, bukan menambah, harga hasil parsing teks Telegram
 * -- RPC create_draft_sales_order_atomic/update_draft_sales_order_atomic
 * tetap sumber otoritatif sebenarnya, ini hanya supaya ringkasan draft yang
 * ditampilkan ke sales SUDAH benar sebelum RPC dipanggil), dan (2) fallback
 * pencocokan word-containment (lihat normalize.ts:containsAllWords) SAAT
 * alias exact-match gagal -- produk TANPA alias terpublikasi pun tetap bisa
 * dipetakan dari variasi bahasa lapangan, bukan hanya via alias manual.
 */
export interface ProductMasterKnowledge {
  productId: string;
  productName: string;
  productCode: string | null;
  price: number;
  isActive: boolean;
}

/**
 * Gate 3E-D4-C7: katalog KANONIK customer (langsung dari tabel customers) --
 * pasangan CustomerAliasKnowledge, dipakai pricing.ts sebagai fallback
 * word-containment SAAT alias exact-match gagal. Lihat ProductMasterKnowledge.
 */
export interface CustomerMasterKnowledge {
  customerId: string;
  customerName: string;
  customerCode: string | null;
  isActive: boolean;
}

/** Snapshot Knowledge Pack aktif satu company — dipakai sekali per ekstraksi. */
export interface KnowledgeContext {
  companyId: string;
  productAliases: ProductAliasKnowledge[];
  customerAliases: CustomerAliasKnowledge[];
  unitAliases: UnitAliasKnowledge[];
  discountPolicies: DiscountPolicyKnowledge[];
  /** Gate 3E-D4-C7: katalog kanonik produk -- lihat ProductMasterKnowledge. */
  products: ProductMasterKnowledge[];
  /** Gate 3E-D4-C7: katalog kanonik customer -- lihat CustomerMasterKnowledge. */
  customers: CustomerMasterKnowledge[];
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
  /** TRUE bila teks produk cocok dengan LEBIH DARI SATU produk berbeda -- productId sengaja null, jangan menebak. */
  productAmbiguous: boolean;
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
  /** TRUE bila teks toko cocok dengan LEBIH DARI SATU customer berbeda -- customerId sengaja null, jangan menebak. */
  customerAmbiguous: boolean;
  items: PricedOrderItem[];
  subtotal: number;
  totalDiscount: number;
  estimatedTotal: number;
  requiresDiscountReview: boolean;
  deliveryNote: string | null;
}
