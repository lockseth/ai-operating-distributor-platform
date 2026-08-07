// =============================================================================
// Knowledge Provider — adapter untuk Published Knowledge (product/customer
// alias, satuan, discount policy) yang dipakai saat ekstraksi order.
//
// Interface ini adalah titik ekstensi wajib (Living Knowledge Platform
// Requirement): implementasi Supabase membaca knowledge_* tables per
// company_id; implementasi in-memory dipakai untuk test dan sebagai
// fallback deterministic jika tabel Knowledge Pack kosong/belum dikonfigurasi
// (bukan error — order tetap bisa diproses, hanya confidence lebih rendah
// dan lebih banyak field yang masuk requiresReview).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  KnowledgeContext,
  ProductAliasKnowledge,
  CustomerAliasKnowledge,
  UnitAliasKnowledge,
  DiscountPolicyKnowledge,
  ProductMasterKnowledge,
  CustomerMasterKnowledge,
} from "./types";

export interface KnowledgeProvider {
  getContext(companyId: string): Promise<KnowledgeContext>;

  /**
   * Simpan koreksi sales (setelah UBAH) sebagai knowledge_candidate.
   * TIDAK PERNAH langsung menjadi Published Knowledge — status selalu 'pending'.
   */
  submitCandidate(input: {
    companyId: string;
    candidateType: "product_alias" | "customer_alias" | "unit_alias" | "other";
    rawText: string;
    suggestedValue: Record<string, unknown>;
    sourceOrderId: string | null;
    submittedBy: string | null;
  }): Promise<void>;
}

function emptyContext(companyId: string): KnowledgeContext {
  return {
    companyId,
    productAliases: [],
    customerAliases: [],
    unitAliases: [],
    discountPolicies: [],
    products: [],
    customers: [],
    knowledgeVersion: "v0-empty",
  };
}

/**
 * knowledge_version = string teraudit deterministik dari jumlah baris +
 * timestamp terbaru Published Knowledge yang dipakai. Bukan FK ke tabel
 * versioning terpisah (di luar scope MVP), tapi bisa diganti tanpa mengubah
 * pemanggil karena disembunyikan di balik fungsi ini.
 */
function computeKnowledgeVersion(parts: {
  productAliases: ProductAliasKnowledge[];
  customerAliases: CustomerAliasKnowledge[];
  unitAliases: UnitAliasKnowledge[];
  discountPolicies: DiscountPolicyKnowledge[];
}): string {
  const all = [
    ...parts.productAliases.map((a) => a.updatedAt),
    ...parts.customerAliases.map((a) => a.updatedAt),
    ...parts.unitAliases.map((a) => a.updatedAt),
    ...parts.discountPolicies.map((a) => a.updatedAt),
  ];
  const count =
    parts.productAliases.length +
    parts.customerAliases.length +
    parts.unitAliases.length +
    parts.discountPolicies.length;

  if (count === 0) return "v0-empty";

  const maxUpdatedAt = all.reduce((max, t) => (t > max ? t : max), all[0]!);
  return `v${count}-${maxUpdatedAt}`;
}

export class SupabaseKnowledgeProvider implements KnowledgeProvider {
  constructor(private readonly supabase: SupabaseClient) {}

  async getContext(companyId: string): Promise<KnowledgeContext> {
    const [productsRes, customersRes, unitsRes, policiesRes, masterProductsRes, masterCustomersRes] =
      await Promise.all([
        this.supabase
          .from("knowledge_product_aliases")
          .select("alias_text, updated_at, product:products!product_id(id, name, sku)")
          .eq("company_id", companyId)
          .eq("is_active", true),
        this.supabase
          .from("knowledge_customer_aliases")
          .select("alias_text, updated_at, customer:customers!customer_id(id, name, code)")
          .eq("company_id", companyId)
          .eq("is_active", true),
        this.supabase
          .from("knowledge_unit_aliases")
          .select("alias_text, canonical_unit, updated_at")
          .eq("company_id", companyId)
          .eq("is_active", true),
        this.supabase
          .from("knowledge_discount_policies")
          .select("scope, product_id, customer_id, max_percentage, max_nominal, updated_at")
          .eq("company_id", companyId)
          .eq("is_active", true),
        // Gate 3E-D4-C7: katalog KANONIK produk langsung dari products,
        // TERPISAH dari query alias di atas (produk bisa punya nol alias
        // sama sekali) -- sumber harga master DAN fallback word-containment
        // (Temuan #4 -- lihat pricing.ts) saat alias exact-match gagal.
        this.supabase.from("products").select("id, name, sku, price, is_active").eq("company_id", companyId),
        // Gate 3E-D4-C7 (Temuan #4): katalog KANONIK customer, pasangan
        // query produk di atas -- fallback word-containment customer.
        this.supabase.from("customers").select("id, name, code, is_active").eq("company_id", companyId),
      ]);

    const productAliases: ProductAliasKnowledge[] = (
      (productsRes.data ?? []) as unknown as {
        alias_text: string;
        updated_at: string;
        product: { id: string; name: string; sku: string } | null;
      }[]
    )
      .filter((r) => r.product !== null)
      .map((r) => ({
        aliasText: r.alias_text,
        productId: r.product!.id,
        productName: r.product!.name,
        productCode: r.product!.sku,
        updatedAt: r.updated_at,
      }));

    const customerAliases: CustomerAliasKnowledge[] = (
      (customersRes.data ?? []) as unknown as {
        alias_text: string;
        updated_at: string;
        customer: { id: string; name: string; code: string } | null;
      }[]
    )
      .filter((r) => r.customer !== null)
      .map((r) => ({
        aliasText: r.alias_text,
        customerId: r.customer!.id,
        customerName: r.customer!.name,
        customerCode: r.customer!.code,
        updatedAt: r.updated_at,
      }));

    const unitAliases: UnitAliasKnowledge[] = (
      (unitsRes.data ?? []) as unknown as { alias_text: string; canonical_unit: string; updated_at: string }[]
    ).map((r) => ({ aliasText: r.alias_text, canonicalUnit: r.canonical_unit, updatedAt: r.updated_at }));

    const discountPolicies: DiscountPolicyKnowledge[] = (
      (policiesRes.data ?? []) as unknown as {
        scope: "global" | "product" | "customer";
        product_id: string | null;
        customer_id: string | null;
        max_percentage: number | null;
        max_nominal: number | null;
        updated_at: string;
      }[]
    ).map((r) => ({
      scope: r.scope,
      productId: r.product_id,
      customerId: r.customer_id,
      maxPercentage: r.max_percentage,
      maxNominal: r.max_nominal,
      updatedAt: r.updated_at,
    }));

    const products: ProductMasterKnowledge[] = (
      (masterProductsRes.data ?? []) as unknown as {
        id: string;
        name: string;
        sku: string;
        price: number;
        is_active: boolean;
      }[]
    ).map((r) => ({ productId: r.id, productName: r.name, productCode: r.sku, price: r.price, isActive: r.is_active }));

    const customers: CustomerMasterKnowledge[] = (
      (masterCustomersRes.data ?? []) as unknown as {
        id: string;
        name: string;
        code: string;
        is_active: boolean;
      }[]
    ).map((r) => ({ customerId: r.id, customerName: r.name, customerCode: r.code, isActive: r.is_active }));

    return {
      companyId,
      productAliases,
      customerAliases,
      unitAliases,
      discountPolicies,
      products,
      customers,
      knowledgeVersion: computeKnowledgeVersion({ productAliases, customerAliases, unitAliases, discountPolicies }),
    };
  }

  async submitCandidate(input: {
    companyId: string;
    candidateType: "product_alias" | "customer_alias" | "unit_alias" | "other";
    rawText: string;
    suggestedValue: Record<string, unknown>;
    sourceOrderId: string | null;
    submittedBy: string | null;
  }): Promise<void> {
    await this.supabase.from("knowledge_candidates").insert({
      company_id: input.companyId,
      candidate_type: input.candidateType,
      raw_text: input.rawText,
      suggested_value: input.suggestedValue,
      source_order_id: input.sourceOrderId,
      submitted_by: input.submittedBy,
      status: "pending",
    });
  }
}

/**
 * Fallback deterministic: tidak ada Published Knowledge sama sekali.
 * Dipakai jika tabel Knowledge Pack belum dikonfigurasi untuk company
 * tertentu, atau di test. Order tetap bisa diproses — hanya lebih banyak
 * field yang requiresReview / confidence lebih rendah.
 */
export class InMemoryKnowledgeProvider implements KnowledgeProvider {
  public readonly submittedCandidates: Array<Parameters<KnowledgeProvider["submitCandidate"]>[0]> = [];

  constructor(private readonly seed: Partial<KnowledgeContext> = {}) {}

  async getContext(companyId: string): Promise<KnowledgeContext> {
    const base = emptyContext(companyId);
    const merged: KnowledgeContext = {
      companyId,
      productAliases: this.seed.productAliases ?? base.productAliases,
      customerAliases: this.seed.customerAliases ?? base.customerAliases,
      unitAliases: this.seed.unitAliases ?? base.unitAliases,
      discountPolicies: this.seed.discountPolicies ?? base.discountPolicies,
      products: this.seed.products ?? base.products,
      customers: this.seed.customers ?? base.customers,
      knowledgeVersion: "",
    };
    merged.knowledgeVersion = computeKnowledgeVersion(merged);
    return merged;
  }

  async submitCandidate(input: Parameters<KnowledgeProvider["submitCandidate"]>[0]): Promise<void> {
    this.submittedCandidates.push(input);
  }
}
