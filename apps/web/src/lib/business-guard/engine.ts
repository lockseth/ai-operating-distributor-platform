// =============================================================================
// Business Guard AI Engine
// Server-side: query riwayat special_price_approval_requests/lines (Gate
// 3E-D4-C1/C2/C3, LOCKED), lalu jalankan detectDiscountAnomaly per sales.
// Read-only -- tidak menyentuh RPC/tabel approval, murni SELECT.
// =============================================================================

import { createClient } from "@/lib/supabase/server";
import {
  detectDiscountAnomaly,
  type DiscountAnomalyResult,
  type SalesDiscountRequest,
} from "./features/discount-anomaly";
import {
  detectCollectionRisk,
  type CollectionRiskResult,
  type OutstandingInvoiceInfo,
} from "./features/collection-risk";

const LOOKBACK_DAYS = 180;

type RequestRow = {
  id: string;
  requested_by: string;
  requested_at: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
};

type LineRow = {
  approval_request_id: string;
  implied_discount_percentage: number | null;
};

type UserRoleRow = {
  user: { id: string; full_name: string } | null;
  role: { name: string } | null;
};

export async function generateDiscountAnomalyReport(
  companyId: string,
  now: Date = new Date()
): Promise<DiscountAnomalyResult[]> {
  const supabase = await createClient();
  const lookbackDate = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const [requestsResult, userRolesResult] = await Promise.all([
    supabase
      .from("special_price_approval_requests")
      .select("id, requested_by, requested_at, status")
      .eq("company_id", companyId)
      .gte("requested_at", lookbackDate.toISOString())
      .order("requested_at", { ascending: true }),
    supabase
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", companyId),
  ]);

  const requests = (requestsResult.data ?? []) as unknown as RequestRow[];
  const salesUsers = ((userRolesResult.data ?? []) as unknown as (UserRoleRow & {
    user: { id: string; full_name: string; is_active: boolean } | null;
  })[])
    .filter((r) => r.role?.name === "sales" && r.user?.is_active)
    .map((r) => ({ id: r.user!.id, full_name: r.user!.full_name }));

  if (requests.length === 0) {
    return salesUsers.map((s) =>
      detectDiscountAnomaly(
        { sales_id: s.id, sales_name: s.full_name, requests: [] },
        { avg_requests_per_sales: 0, avg_discount_percentage: 0 },
        now
      )
    );
  }

  const requestIds = requests.map((r) => r.id);
  const { data: lineRows } = await supabase
    .from("special_price_approval_lines")
    .select("approval_request_id, implied_discount_percentage")
    .in("approval_request_id", requestIds);
  const lines = (lineRows ?? []) as unknown as LineRow[];

  // Diskon terdalam per pengajuan (MAX antar baris pada 1 approval_request_id)
  const maxDiscountByRequest = new Map<string, number>();
  lines.forEach((l) => {
    const value = l.implied_discount_percentage ?? 0;
    const current = maxDiscountByRequest.get(l.approval_request_id) ?? 0;
    if (value > current) maxDiscountByRequest.set(l.approval_request_id, value);
  });

  const userMap = new Map(salesUsers.map((s) => [s.id, s.full_name]));

  const bySales = new Map<string, SalesDiscountRequest[]>();
  requests.forEach((r) => {
    if (!bySales.has(r.requested_by)) bySales.set(r.requested_by, []);
    bySales.get(r.requested_by)!.push({
      status: r.status,
      requested_at: r.requested_at,
      max_discount_percentage: maxDiscountByRequest.get(r.id) ?? 0,
    });
  });

  // Pastikan sales aktif tanpa pengajuan sama sekali tetap muncul (risk NONE) --
  // sama seperti generateAllInsights mengembalikan seluruh customer, bukan
  // hanya yang punya order.
  salesUsers.forEach((s) => {
    if (!bySales.has(s.id)) bySales.set(s.id, []);
  });

  const totalRequests = requests.length;
  const salesCountWithActivity = bySales.size;
  const avgRequestsPerSales = salesCountWithActivity > 0 ? totalRequests / salesCountWithActivity : 0;
  const allDiscounts = requests.map((r) => maxDiscountByRequest.get(r.id) ?? 0);
  const avgDiscountPercentage =
    allDiscounts.length > 0 ? allDiscounts.reduce((s, v) => s + v, 0) / allDiscounts.length : 0;

  const peerBaseline = {
    avg_requests_per_sales: avgRequestsPerSales,
    avg_discount_percentage: avgDiscountPercentage,
  };

  const results: DiscountAnomalyResult[] = [];
  bySales.forEach((salesRequests, salesId) => {
    const salesName = userMap.get(salesId) ?? "Sales (tidak dikenal)";
    results.push(detectDiscountAnomaly({ sales_id: salesId, sales_name: salesName, requests: salesRequests }, peerBaseline, now));
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || b.total_requests - a.total_requests;
  });
}

// =============================================================================
// Collection Risk -- query invoice_receivable_balances (Gate 2A, view) +
// invoices + promises_to_pay + collection_activities (Gate 2C, LOCKED), lalu
// jalankan detectCollectionRisk per customer. Read-only -- tidak menyentuh RPC
// collection (record_collection_activity/create_promise_to_pay/dst.) sama
// sekali, murni SELECT.
// =============================================================================

const COLLECTION_RISK_LOOKBACK_DAYS = 180;

type BalanceRow = { invoice_id: string; outstanding_balance: number; financial_status: string };
type InvoiceRow = {
  id: string;
  invoice_number: string;
  customer_id: string;
  due_date: string | null;
  customers: { name: string } | { name: string }[] | null;
};
type BrokenPromiseRow = { customer_id: string };
type ActivityRow = { customer_id: string; outcome: string | null; occurred_at: string };

function resolveCustomerName(customers: InvoiceRow["customers"]): string {
  if (!customers) return "-";
  return Array.isArray(customers) ? (customers[0]?.name ?? "-") : customers.name;
}

export async function generateCollectionRiskReport(
  companyId: string,
  now: Date = new Date(),
): Promise<CollectionRiskResult[]> {
  const supabase = await createClient();
  const lookbackDate = new Date(now.getTime() - COLLECTION_RISK_LOOKBACK_DAYS * 86_400_000);

  const { data: balanceRows } = await supabase
    .from("invoice_receivable_balances")
    .select("invoice_id, outstanding_balance, financial_status")
    .eq("company_id", companyId)
    .in("financial_status", ["outstanding", "partially_paid"]);

  const balances = (balanceRows ?? []) as BalanceRow[];
  if (balances.length === 0) return [];

  const balanceMap = new Map(balances.map((b) => [b.invoice_id, b.outstanding_balance]));
  const invoiceIds = balances.map((b) => b.invoice_id);

  const [invoiceRes, brokenPromiseRes, activityRes] = await Promise.all([
    supabase
      .from("invoices")
      .select("id, invoice_number, customer_id, due_date, customers(name)")
      .eq("company_id", companyId)
      .in("id", invoiceIds),
    supabase
      .from("promises_to_pay")
      .select("customer_id")
      .eq("company_id", companyId)
      .eq("status", "broken")
      .gte("promised_date", lookbackDate.toISOString().slice(0, 10)),
    supabase
      .from("collection_activities")
      .select("customer_id, outcome, occurred_at")
      .eq("company_id", companyId)
      .gte("occurred_at", lookbackDate.toISOString())
      .order("occurred_at", { ascending: false }),
  ]);

  const invoices = (invoiceRes.data ?? []) as unknown as InvoiceRow[];

  const brokenPromiseCounts = new Map<string, number>();
  ((brokenPromiseRes.data ?? []) as BrokenPromiseRow[]).forEach((p) => {
    brokenPromiseCounts.set(p.customer_id, (brokenPromiseCounts.get(p.customer_id) ?? 0) + 1);
  });

  // Sudah di-order occurred_at DESC -- entri pertama per customer_id = aktivitas terbaru.
  const latestActivityByCustomer = new Map<string, ActivityRow>();
  ((activityRes.data ?? []) as ActivityRow[]).forEach((a) => {
    if (!latestActivityByCustomer.has(a.customer_id)) latestActivityByCustomer.set(a.customer_id, a);
  });

  const byCustomer = new Map<
    string,
    { customer_id: string; customer_name: string; outstanding_invoices: OutstandingInvoiceInfo[] }
  >();
  invoices.forEach((inv) => {
    const balance = balanceMap.get(inv.id) ?? 0;
    if (balance <= 0) return;
    const existing = byCustomer.get(inv.customer_id) ?? {
      customer_id: inv.customer_id,
      customer_name: resolveCustomerName(inv.customers),
      outstanding_invoices: [],
    };
    existing.outstanding_invoices.push({
      invoice_number: inv.invoice_number,
      due_date: inv.due_date,
      outstanding_balance: balance,
    });
    byCustomer.set(inv.customer_id, existing);
  });

  const results: CollectionRiskResult[] = [];
  byCustomer.forEach((c) => {
    const latestActivity = latestActivityByCustomer.get(c.customer_id);
    results.push(
      detectCollectionRisk(
        {
          customer_id: c.customer_id,
          customer_name: c.customer_name,
          outstanding_invoices: c.outstanding_invoices,
          broken_promise_count: brokenPromiseCounts.get(c.customer_id) ?? 0,
          has_unresolved_dispute: latestActivity?.outcome === "dispute",
        },
        now,
      ),
    );
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || b.total_outstanding_amount - a.total_outstanding_amount;
  });
}
