// =============================================================================
// Fondasi data chatbot bisnis Owner -- pure aggregation function (tanpa I/O),
// supaya bisa diuji unit tanpa DB. Pola sama dengan aggregateGovernedKpis
// (lib/executive/contributors/flowsales.ts): fungsi murni menerima baris hasil
// query, pemanggil (snapshot.ts) yang urus fetch dari Supabase.
// =============================================================================

export interface ProductSaleRow {
  product_id: string | null;
  product_name: string;
  quantity: number;
  revenue: number;
}

export interface TopProductResult {
  product_name: string;
  total_quantity: number;
  total_revenue: number;
}

export function aggregateTopProducts(rows: ProductSaleRow[], limit = 10): TopProductResult[] {
  const byProduct = new Map<string, TopProductResult>();
  rows.forEach((r) => {
    const key = r.product_id ?? r.product_name;
    const existing = byProduct.get(key) ?? { product_name: r.product_name, total_quantity: 0, total_revenue: 0 };
    existing.total_quantity += r.quantity;
    existing.total_revenue += r.revenue;
    byProduct.set(key, existing);
  });
  return Array.from(byProduct.values())
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, limit);
}

export interface CustomerOrderRow {
  customer_id: string;
  customer_name: string;
  final_amount: number;
}

export interface TopCustomerResult {
  customer_id: string;
  customer_name: string;
  order_count: number;
  total_revenue: number;
}

export function aggregateTopCustomers(rows: CustomerOrderRow[], limit = 10): TopCustomerResult[] {
  const byCustomer = new Map<string, TopCustomerResult>();
  rows.forEach((r) => {
    const existing = byCustomer.get(r.customer_id) ?? {
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      order_count: 0,
      total_revenue: 0,
    };
    existing.order_count += 1;
    existing.total_revenue += r.final_amount;
    byCustomer.set(r.customer_id, existing);
  });
  return Array.from(byCustomer.values())
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, limit);
}

export type SummarizableRiskLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface RiskLevelCounts {
  high: number;
  medium: number;
  low: number;
}

export function summarizeRiskLevels(levels: SummarizableRiskLevel[]): RiskLevelCounts {
  return {
    high: levels.filter((l) => l === "HIGH").length,
    medium: levels.filter((l) => l === "MEDIUM").length,
    low: levels.filter((l) => l === "LOW").length,
  };
}
