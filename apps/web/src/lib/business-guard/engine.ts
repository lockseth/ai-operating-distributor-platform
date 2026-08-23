// =============================================================================
// Business Guard AI Engine
// Server-side: query riwayat special_price_approval_requests/lines (Gate
// 3E-D4-C1/C2/C3, LOCKED), lalu jalankan detectDiscountAnomaly per sales.
// Read-only -- tidak menyentuh RPC/tabel approval, murni SELECT.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
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
import { detectBehaviorChange, type BehaviorChangeResult } from "./features/behavior-change";
import {
  detectTransactionRisk,
  type TransactionRiskResult,
  type OrderItemQuantityOutlier,
} from "./features/transaction-risk";
import {
  matchUnremittedClaims,
  detectUnremittedCollectionRisk,
  type UnremittedCollectionResult,
  type ClaimedActivityInput,
  type PaymentClaimInput,
} from "./features/unremitted-collection";
import {
  detectSuspiciousCallTiming,
  type SalesCallTimingResult,
  type SalesDayCallActivity,
  type SalesCallTimingInput,
} from "./features/call-timing-anomaly";

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

// =============================================================================
// Behavior Change -- query sales_orders (confirmed_at, untuk baseline pola
// order per customer) + customer_relationship_events (Gate PIC master
// 2026-07-28, LOCKED, sudah mencatat PIC_NAME_CHANGED/PIC_PHONE_CHANGED/
// PIC_ADDED/PIC_DEACTIVATED/DUPLICATE_PIC_DETECTED/DUPLICATE_STORE_DETECTED),
// lalu jalankan detectBehaviorChange per customer aktif. Read-only -- tidak
// menyentuh RPC PIC/order sama sekali, murni SELECT.
// =============================================================================

const BEHAVIOR_CHANGE_LOOKBACK_DAYS = 180;

const PIC_FIELD_CHANGE_EVENTS = new Set(["PIC_NAME_CHANGED", "PIC_PHONE_CHANGED"]);
const DUPLICATE_EVENTS = new Set(["DUPLICATE_PIC_DETECTED", "DUPLICATE_STORE_DETECTED"]);

type CustomerRow = { id: string; name: string };
type OrderDateRow = { customer_id: string; confirmed_at: string };
type RelationshipEventRow = { customer_id: string; event_type: string };

export async function generateBehaviorChangeReport(
  companyId: string,
  now: Date = new Date(),
): Promise<BehaviorChangeResult[]> {
  const supabase = await createClient();
  const lookbackDate = new Date(now.getTime() - BEHAVIOR_CHANGE_LOOKBACK_DAYS * 86_400_000);

  const [customersResult, ordersResult, eventsResult] = await Promise.all([
    supabase.from("customers").select("id, name").eq("company_id", companyId).eq("is_active", true),
    supabase
      .from("sales_orders")
      .select("customer_id, confirmed_at")
      .eq("company_id", companyId)
      .not("confirmed_at", "is", null)
      .gte("confirmed_at", lookbackDate.toISOString()),
    supabase
      .from("customer_relationship_events")
      .select("customer_id, event_type")
      .eq("company_id", companyId)
      .gte("created_at", lookbackDate.toISOString()),
  ]);

  const customers = (customersResult.data ?? []) as CustomerRow[];
  if (customers.length === 0) return [];

  const ordersByCustomer = new Map<string, string[]>();
  ((ordersResult.data ?? []) as OrderDateRow[]).forEach((o) => {
    if (!ordersByCustomer.has(o.customer_id)) ordersByCustomer.set(o.customer_id, []);
    ordersByCustomer.get(o.customer_id)!.push(o.confirmed_at);
  });

  type PicActivity = { fieldChangeCount: number; hasDeactivated: boolean; hasAdded: boolean; hasDuplicate: boolean };
  const picActivityByCustomer = new Map<string, PicActivity>();
  ((eventsResult.data ?? []) as RelationshipEventRow[]).forEach((e) => {
    const entry: PicActivity = picActivityByCustomer.get(e.customer_id) ?? {
      fieldChangeCount: 0,
      hasDeactivated: false,
      hasAdded: false,
      hasDuplicate: false,
    };
    if (PIC_FIELD_CHANGE_EVENTS.has(e.event_type)) entry.fieldChangeCount += 1;
    if (e.event_type === "PIC_DEACTIVATED") entry.hasDeactivated = true;
    if (e.event_type === "PIC_ADDED") entry.hasAdded = true;
    if (DUPLICATE_EVENTS.has(e.event_type)) entry.hasDuplicate = true;
    picActivityByCustomer.set(e.customer_id, entry);
  });

  const results = customers.map((c) => {
    const picActivity = picActivityByCustomer.get(c.id);
    return detectBehaviorChange(
      {
        customer_id: c.id,
        customer_name: c.name,
        confirmed_order_dates: ordersByCustomer.get(c.id) ?? [],
        pic_field_change_count: picActivity?.fieldChangeCount ?? 0,
        pic_fully_replaced: !!(picActivity?.hasDeactivated && picActivity?.hasAdded),
        has_duplicate_flag: picActivity?.hasDuplicate ?? false,
      },
      now,
    );
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]!;
  });
}

// =============================================================================
// Transaction Risk Score -- skor PER TRANSAKSI (order individual), beda dari
// 3 slice lain yang agregat per-entity. Query sales_orders (final_amount,
// dipisah window baseline 180 hari vs recent 30 hari supaya order yang
// dinilai tidak ikut mencemari baseline-nya sendiri) + sales_order_items
// (quantity per produk), lalu jalankan detectTransactionRisk per order dalam
// window recent. Read-only -- tidak menyentuh RPC order sama sekali.
// =============================================================================

const TX_RISK_LOOKBACK_DAYS = 180;
const TX_RISK_RECENT_WINDOW_DAYS = 30;
const MIN_LINES_FOR_PRODUCT_BASELINE = 3;
const QUANTITY_OUTLIER_MULTIPLIER = 3;

type ScoredOrderRow = {
  id: string;
  order_number: string;
  customer_id: string;
  confirmed_at: string;
  final_amount: number;
  customer: { name: string } | { name: string }[] | null;
};
type BaselineOrderRow = { id: string; customer_id: string; final_amount: number };
type OrderItemRow = { order_id: string; product_id: string | null; product_name_raw: string; quantity: number };

export async function generateTransactionRiskReport(
  companyId: string,
  now: Date = new Date(),
): Promise<TransactionRiskResult[]> {
  const supabase = await createClient();
  const baselineStart = new Date(now.getTime() - TX_RISK_LOOKBACK_DAYS * 86_400_000);
  const recentStart = new Date(now.getTime() - TX_RISK_RECENT_WINDOW_DAYS * 86_400_000);

  const [recentResult, baselineResult] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("id, order_number, customer_id, confirmed_at, final_amount, customer:customers!customer_id(name)")
      .eq("company_id", companyId)
      .not("confirmed_at", "is", null)
      .gte("confirmed_at", recentStart.toISOString())
      .order("confirmed_at", { ascending: false }),
    supabase
      .from("sales_orders")
      .select("id, customer_id, final_amount")
      .eq("company_id", companyId)
      .not("confirmed_at", "is", null)
      .gte("confirmed_at", baselineStart.toISOString())
      .lt("confirmed_at", recentStart.toISOString()),
  ]);

  const recentOrders = (recentResult.data ?? []) as unknown as ScoredOrderRow[];
  if (recentOrders.length === 0) return [];

  const baselineOrders = (baselineResult.data ?? []) as BaselineOrderRow[];
  const recentOrderIds = recentOrders.map((o) => o.id);
  const baselineOrderIds = baselineOrders.map((o) => o.id);

  const [recentItemsResult, baselineItemsResult] = await Promise.all([
    recentOrderIds.length > 0
      ? supabase.from("sales_order_items").select("order_id, product_id, product_name_raw, quantity").in("order_id", recentOrderIds)
      : Promise.resolve({ data: [] }),
    baselineOrderIds.length > 0
      ? supabase.from("sales_order_items").select("order_id, product_id, product_name_raw, quantity").in("order_id", baselineOrderIds)
      : Promise.resolve({ data: [] }),
  ]);

  const recentItems = (recentItemsResult.data ?? []) as OrderItemRow[];
  const baselineItems = (baselineItemsResult.data ?? []) as OrderItemRow[];

  // Baseline per-customer avg final_amount, dari order SEBELUM window recent
  // (order yang sedang dinilai tidak ikut membentuk baseline-nya sendiri).
  const customerBaseline = new Map<string, { sum: number; count: number }>();
  baselineOrders.forEach((o) => {
    const entry = customerBaseline.get(o.customer_id) ?? { sum: 0, count: 0 };
    entry.sum += o.final_amount;
    entry.count += 1;
    customerBaseline.set(o.customer_id, entry);
  });

  const companyAvgOrderValue =
    baselineOrders.length > 0
      ? baselineOrders.reduce((s, o) => s + o.final_amount, 0) / baselineOrders.length
      : recentOrders.reduce((s, o) => s + o.final_amount, 0) / recentOrders.length;

  // Baseline per-produk avg quantity per baris, dari order SEBELUM window recent.
  const productBaseline = new Map<string, { sum: number; count: number }>();
  baselineItems.forEach((it) => {
    const key = it.product_id ?? it.product_name_raw;
    const entry = productBaseline.get(key) ?? { sum: 0, count: 0 };
    entry.sum += it.quantity;
    entry.count += 1;
    productBaseline.set(key, entry);
  });

  const itemsByOrder = new Map<string, OrderItemRow[]>();
  recentItems.forEach((it) => {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id)!.push(it);
  });

  const results = recentOrders.map((o) => {
    const custBaseline = customerBaseline.get(o.customer_id);
    const items = itemsByOrder.get(o.id) ?? [];
    const outliers: OrderItemQuantityOutlier[] = [];
    items.forEach((it) => {
      const key = it.product_id ?? it.product_name_raw;
      const prodBaseline = productBaseline.get(key);
      if (!prodBaseline || prodBaseline.count < MIN_LINES_FOR_PRODUCT_BASELINE) return;
      const avgQty = prodBaseline.sum / prodBaseline.count;
      if (avgQty > 0 && it.quantity > avgQty * QUANTITY_OUTLIER_MULTIPLIER) {
        outliers.push({ product_name: it.product_name_raw, quantity: it.quantity, avg_quantity: avgQty });
      }
    });

    return detectTransactionRisk(
      {
        order_id: o.id,
        order_number: o.order_number,
        customer_id: o.customer_id,
        customer_name: resolveCustomerName(o.customer),
        confirmed_at: o.confirmed_at,
        order_total_amount: o.final_amount,
        customer_avg_order_value: custBaseline && custBaseline.count > 0 ? custBaseline.sum / custBaseline.count : null,
        is_first_order: !custBaseline || custBaseline.count === 0,
        company_avg_order_value: companyAvgOrderValue,
        item_quantity_outliers: outliers,
      },
      now,
    );
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || b.order_total_amount - a.order_total_amount;
  });
}

// =============================================================================
// Unremitted Collection Risk (Gate P4.18) -- query collection_activities
// (klaim "sudah terima pembayaran", Gate 2C LOCKED) + payment_claims (klaim
// resmi, Gate P4.06 LOCKED), cocokkan lewat matchUnremittedClaims (Business
// Guard feature murni), lalu jalankan detectUnremittedCollectionRisk per
// aktivitas yang belum matched. Read-only -- tidak menyentuh RPC manapun.
//
// PENTING -- BEDA dari 4 fungsi generate*Report di atas: fungsi ini SELALU
// pakai admin client (getAdminClient()), TIDAK PERNAH createClient() session-
// scoped. Alasan: payment_claims_select RLS (20261010000001) HANYA
// mengizinkan lihat SEMUA baris kalau permission 'payment.record' -- dan
// permission itu HANYA di-grant ke role owner/finance (20260829000001,
// SENGAJA lebih sempit dari manager/admin/super_admin). Kalau fungsi ini
// pakai createClient() biasa, seorang manager yang buka halaman Risk Alert
// akan RLS-filtered ke nyaris 0 baris payment_claims terlihat -- membuat
// SEMUA sales tampak "tidak pernah formalkan klaim" (HIGH risk PALSU untuk
// semua orang). Admin client di sini aman karena setiap pemanggil (dashboard,
// Executive Overview, cron KPI Daily Summary) SUDAH gate akses halaman ke
// owner/manager/super_admin duluan -- ini cuma memastikan audiens yang sudah
// dipercaya melihat data yang BENAR, bukan data yang salah kena RLS.
// JANGAN ganti balik ke createClient() session-scoped -- itu akan
// menghidupkan kembali bug false-positive massal ini.
// =============================================================================

const UNREMITTED_LOOKBACK_DAYS = 90;

type ClaimedActivityRow = {
  id: string;
  customer_id: string;
  collector_id: string;
  outcome: "claimed_paid_full" | "claimed_paid_partial";
  reported_amount: number | null;
  occurred_at: string;
  customers: { name: string } | { name: string }[] | null;
};
type PaymentClaimRow = { id: string; customer_id: string; claimed_by: string; claimed_at: string };
type UserNameRow = { id: string; full_name: string };

/**
 * Fungsi data-fetching dengan client yang DI-INJECT (bukan hardcode) --
 * dipakai LANGSUNG oleh generateUnremittedCollectionRiskReport (admin
 * client) DAN oleh route KPI Daily Summary (admin client juga, lihat header
 * di atas kenapa fungsi ini tidak butuh varian terpisah seperti pola churn
 * Gate P4.17 -- di sini SEMUA pemanggil butuh admin client yang sama).
 */
export async function getUnremittedCollectionCandidates(
  companyId: string,
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<UnremittedCollectionResult[]> {
  const lookbackDate = new Date(now.getTime() - UNREMITTED_LOOKBACK_DAYS * 86_400_000);

  const [activitiesResult, claimsResult] = await Promise.all([
    supabase
      .from("collection_activities")
      .select("id, customer_id, collector_id, outcome, reported_amount, occurred_at, customers(name)")
      .eq("company_id", companyId)
      .in("outcome", ["claimed_paid_full", "claimed_paid_partial"])
      .gte("occurred_at", lookbackDate.toISOString()),
    supabase
      .from("payment_claims")
      .select("id, customer_id, claimed_by, claimed_at")
      .eq("company_id", companyId)
      .gte("claimed_at", lookbackDate.toISOString()),
  ]);

  const activityRows = (activitiesResult.data ?? []) as unknown as ClaimedActivityRow[];
  if (activityRows.length === 0) return [];

  const claimRows = (claimsResult.data ?? []) as PaymentClaimRow[];

  const collectorIds = [...new Set(activityRows.map((a) => a.collector_id))];
  const { data: userRows } = await supabase.from("users").select("id, full_name").in("id", collectorIds);
  const collectorNameById = new Map(((userRows ?? []) as UserNameRow[]).map((u) => [u.id, u.full_name]));

  const activities: ClaimedActivityInput[] = activityRows.map((a) => ({
    activity_id: a.id,
    customer_id: a.customer_id,
    customer_name: resolveCustomerName(a.customers),
    collector_id: a.collector_id,
    collector_name: collectorNameById.get(a.collector_id) ?? "Sales (tidak dikenal)",
    outcome: a.outcome,
    reported_amount: a.reported_amount,
    occurred_at: a.occurred_at,
  }));

  const claims: PaymentClaimInput[] = claimRows.map((c) => ({
    claim_id: c.id,
    customer_id: c.customer_id,
    claimed_by: c.claimed_by,
    claimed_at: c.claimed_at,
  }));

  const matched = matchUnremittedClaims(activities, claims);
  const results = matched.map((a) => detectUnremittedCollectionRisk(a, now));

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || b.days_elapsed - a.days_elapsed;
  });
}

export async function generateUnremittedCollectionRiskReport(
  companyId: string,
  now: Date = new Date(),
): Promise<UnremittedCollectionResult[]> {
  return getUnremittedCollectionCandidates(companyId, getAdminClient(), now);
}

// =============================================================================
// Suspicious Call Timing (Gate P4.19) -- query sales_calls (Call jalur
// Telegram, LOCKED, Gate 3E-D5) untuk VALID + coverage_basis ASSIGNED/AREA/
// EXCEPTION saja, kelompokkan per (salesperson_id, call_date), lalu jalankan
// detectSuspiciousCallTiming per grup yang punya >= 2 Call. Read-only --
// tidak menyentuh RPC record_sales_call/reverse_sales_call sama sekali.
//
// BEDA dari Gate P4.18: sales_calls_select RLS (20260805000001:164-171) SUDAH
// benar untuk owner/manager/super_admin (lihat kolom salesperson_id = auth.uid()
// OR user_has_role([...])) -- TIDAK ADA celah RLS seperti payment_claims.
// generateSuspiciousCallTimingReport pakai createClient() session-scoped
// BIASA. Admin client HANYA dipakai jalur cron KPI Daily Summary (route tidak
// pernah punya sesi cookie) -- reuse fungsi yang sama, BUKAN workaround bug RLS.
// =============================================================================

const CALL_TIMING_LOOKBACK_DAYS = 30;
const TELEGRAM_COVERAGE_BASIS = ["ASSIGNED", "AREA", "EXCEPTION"] as const;

type SalesCallRow = {
  id: string;
  salesperson_id: string;
  customer_id: string;
  call_date: string;
  occurred_at: string;
  customers: { name: string } | { name: string }[] | null;
};

/**
 * Fungsi data-fetching dengan client yang DI-INJECT -- dipakai
 * generateSuspiciousCallTimingReport (session-scoped, RLS sudah benar) DAN
 * route KPI Daily Summary (admin client, route automation tidak punya sesi).
 */
export async function getSuspiciousCallTimingCandidates(
  companyId: string,
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<SalesCallTimingResult[]> {
  const lookbackDate = new Date(now.getTime() - CALL_TIMING_LOOKBACK_DAYS * 86_400_000);

  const { data: callRows } = await supabase
    .from("sales_calls")
    .select("id, salesperson_id, customer_id, call_date, occurred_at, customers(name)")
    .eq("company_id", companyId)
    .eq("status", "VALID")
    .in("coverage_basis", TELEGRAM_COVERAGE_BASIS)
    .gte("call_date", lookbackDate.toISOString().slice(0, 10));

  const rows = (callRows ?? []) as unknown as SalesCallRow[];
  if (rows.length === 0) return [];

  const salespersonIds = [...new Set(rows.map((r) => r.salesperson_id))];
  const { data: userRows } = await supabase.from("users").select("id, full_name").in("id", salespersonIds);
  const salespersonNameById = new Map(((userRows ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));

  const groupKey = (salespersonId: string, callDate: string): string => `${salespersonId}:${callDate}`;
  const groups = new Map<string, SalesDayCallActivity>();
  rows.forEach((r) => {
    const key = groupKey(r.salesperson_id, r.call_date);
    const group = groups.get(key) ?? {
      salesperson_id: r.salesperson_id,
      salesperson_name: salespersonNameById.get(r.salesperson_id) ?? "Sales (tidak dikenal)",
      call_date: r.call_date,
      calls: [] as SalesCallTimingInput[],
    };
    group.calls.push({
      call_id: r.id,
      customer_id: r.customer_id,
      customer_name: resolveCustomerName(r.customers),
      occurred_at: r.occurred_at,
    });
    groups.set(key, group);
  });

  const results: SalesCallTimingResult[] = [];
  groups.forEach((group) => {
    if (group.calls.length < 2) return;
    results.push(detectSuspiciousCallTiming(group, now));
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || (a.min_gap_seconds ?? Infinity) - (b.min_gap_seconds ?? Infinity);
  });
}

export async function generateSuspiciousCallTimingReport(
  companyId: string,
  now: Date = new Date(),
): Promise<SalesCallTimingResult[]> {
  const supabase = await createClient();
  return getSuspiciousCallTimingCandidates(companyId, supabase, now);
}
