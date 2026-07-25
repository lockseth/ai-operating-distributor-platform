// =============================================================================
// Gate 2I.1 -- Finance Operations Workspace: canonical server-side read model.
//
// Satu-satunya boundary read untuk workspace (kontrak §3/§12 GAP G1). Semua
// query berjalan lewat client session-scoped (createClient(), bukan
// admin/service-role) sehingga tenant isolation + permission gate mengikuti
// RLS existing (public.user_has_permission('receivable.view') pada setiap
// tabel/view sumber -- lihat migration Gate 2A/2C/2D/2E/2F/2G/2H). Outstanding
// SELALU dari invoice_receivable_balances/payment_reconciliation_exceptions/
// customer_credit_balances -- tidak pernah dihitung ulang di sini.
//
// Kegagalan satu kategori TIDAK PERNAH ditelan jadi array kosong -- setiap
// fetcher melempar Error saat query gagal, ditangkap per-kategori lewat
// Promise.allSettled (getFinanceActionQueue), dan kategori yang gagal
// dilaporkan lewat failedCategories, bukan disamarkan sebagai "0 tindakan".
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { StatusDomain } from "@/components/dashboard/status-badge";

export const FINANCE_WORKSPACE_PERMISSION = "receivable.view";

export function hasFinanceWorkspaceAccess(permissions: string[]): boolean {
  return permissions.includes(FINANCE_WORKSPACE_PERMISSION);
}

export type FinanceActionCategory =
  | "invoice_overdue"
  | "reconciliation_exception"
  | "payment_unverified"
  | "promise_due"
  | "return_pending"
  | "refund_pending"
  | "cancellation_pending"
  | "invoice_void_notice";

export interface FinanceActionQueueItem {
  id: string;
  category: FinanceActionCategory;
  categoryLabel: string;
  entityLabel: string;
  referenceNumber: string;
  amount: number | null;
  statusCode: string;
  statusDomain: StatusDomain;
  eventDate: string | null;
  ageDays: number | null;
  ownerOnly: boolean;
  roleNote: string;
}

export interface FinanceActionQueueResult {
  items: FinanceActionQueueItem[];
  failedCategories: FinanceActionCategory[];
}

interface CategoryMeta {
  label: string;
  priority: number;
  ownerOnly: boolean;
  roleNote: string;
}

// Priority menentukan urutan tampil (angka kecil = lebih dulu): integritas
// data finansial (exception/overdue) didahulukan atas keputusan pending yang
// masih menunggu Owner, notice void/reversal read-only ditaruh paling akhir
// karena bukan "tindakan" sesungguhnya (§3 tabel item #8 kontrak).
export const FINANCE_ACTION_CATEGORY_META: Record<FinanceActionCategory, CategoryMeta> = {
  invoice_overdue: {
    label: "Invoice jatuh tempo/overdue",
    priority: 1,
    ownerOnly: false,
    roleNote: "Owner/Finance",
  },
  reconciliation_exception: {
    label: "Payment allocation/reconciliation exception",
    priority: 2,
    ownerOnly: false,
    roleNote: "Owner/Finance",
  },
  payment_unverified: {
    label: "Bukti pembayaran menunggu verifikasi",
    priority: 3,
    ownerOnly: false,
    roleNote: "Owner/Finance",
  },
  promise_due: {
    label: "Janji bayar jatuh tempo/terlewat",
    priority: 4,
    ownerOnly: false,
    roleNote: "Owner/Finance/Manager/Admin/Super Admin",
  },
  return_pending: {
    label: "Return menunggu keputusan",
    priority: 5,
    ownerOnly: true,
    roleNote: "Owner",
  },
  refund_pending: {
    label: "Refund menunggu keputusan Owner",
    priority: 6,
    ownerOnly: true,
    roleNote: "Owner",
  },
  cancellation_pending: {
    label: "Cancellation menunggu keputusan Owner",
    priority: 7,
    ownerOnly: true,
    roleNote: "Owner",
  },
  invoice_void_notice: {
    label: "Invoice void/reversal perlu perhatian",
    priority: 8,
    ownerOnly: false,
    roleNote: "Read-only",
  },
};

const CATEGORY_ORDER: FinanceActionCategory[] = [
  "invoice_overdue",
  "reconciliation_exception",
  "payment_unverified",
  "promise_due",
  "return_pending",
  "refund_pending",
  "cancellation_pending",
  "invoice_void_notice",
];

const QUEUE_LIMIT_PER_CATEGORY = 50;

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable tanpa DB).
// ---------------------------------------------------------------------------

export function computeAgeDays(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24)));
}

export function sortActionQueueItems(items: FinanceActionQueueItem[]): FinanceActionQueueItem[] {
  return [...items].sort((a, b) => {
    const pa = FINANCE_ACTION_CATEGORY_META[a.category].priority;
    const pb = FINANCE_ACTION_CATEGORY_META[b.category].priority;
    if (pa !== pb) return pa - pb;
    const aAge = a.ageDays ?? -1;
    const bAge = b.ageDays ?? -1;
    if (aAge !== bAge) return bAge - aAge;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Row shapes (subset kolom yang benar-benar dipakai, sesuai migration).
// ---------------------------------------------------------------------------

interface InvoiceOverdueRow {
  id: string;
  invoice_number: string;
  due_date: string | null;
  customers: { name: string } | null;
}

interface BalanceRow {
  invoice_id: string;
  outstanding_balance: number;
  financial_status: string;
}

interface PromiseRow {
  id: string;
  promised_amount: number;
  promised_date: string;
  invoices: { invoice_number: string } | null;
  customers: { name: string } | null;
}

interface ReceiptRow {
  id: string;
  amount: number;
  received_at: string;
  customers: { name: string } | null;
}

interface ReconciliationExceptionRow {
  id: string;
  payment_receipt_id: string;
  customer_id: string;
  classification: string;
  unallocated_amount: number;
  created_at: string;
}

interface ReturnRow {
  id: string;
  requested_at: string;
  invoices: { invoice_number: string } | null;
  customers: { name: string } | null;
}

interface RefundRow {
  id: string;
  amount: number;
  requested_at: string;
  credit_notes: { invoices: { invoice_number: string } | null } | null;
  customers: { name: string } | null;
}

interface CancellationRow {
  id: string;
  requested_at: string;
  sales_orders: { order_number: string; customers: { name: string } | null } | null;
}

interface InvoiceVoidRow {
  id: string;
  voided_amount: number;
  created_at: string;
  invoices: { invoice_number: string; customers: { name: string } | null } | null;
}

interface ReversalRow {
  id: string;
  reversed_amount: number;
  created_at: string;
  credit_notes: { invoices: { invoice_number: string } | null; customers: { name: string } | null } | null;
}

// ---------------------------------------------------------------------------
// Per-kategori fetcher -- masing-masing melempar Error saat query gagal
// (tidak pernah mengembalikan [] pada error).
// ---------------------------------------------------------------------------

async function fetchOverdueInvoices(
  supabase: SupabaseClient,
  companyId: string,
  todayIso: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data: invoiceRows, error: invErr } = await supabase
    .from("invoices")
    .select("id, invoice_number, due_date, customers(name)")
    .eq("company_id", companyId)
    .not("due_date", "is", null)
    .lte("due_date", todayIso)
    .order("due_date", { ascending: true })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (invErr) throw new Error(`invoice_overdue: ${invErr.message}`);

  const rows = (invoiceRows ?? []) as unknown as InvoiceOverdueRow[];
  if (rows.length === 0) return [];

  const { data: balanceRows, error: balErr } = await supabase
    .from("invoice_receivable_balances")
    .select("invoice_id, outstanding_balance, financial_status")
    .in("invoice_id", rows.map((r) => r.id));
  if (balErr) throw new Error(`invoice_overdue balances: ${balErr.message}`);

  const balanceMap = new Map(
    ((balanceRows ?? []) as unknown as BalanceRow[]).map((b) => [b.invoice_id, b])
  );

  const items: FinanceActionQueueItem[] = [];
  for (const row of rows) {
    const balance = balanceMap.get(row.id);
    if (!balance) continue;
    if (balance.financial_status !== "outstanding" && balance.financial_status !== "partially_paid") continue;
    items.push({
      id: `invoice_overdue:${row.id}`,
      category: "invoice_overdue",
      categoryLabel: FINANCE_ACTION_CATEGORY_META.invoice_overdue.label,
      entityLabel: row.customers?.name ?? "-",
      referenceNumber: row.invoice_number,
      amount: balance.outstanding_balance,
      statusCode: balance.financial_status,
      statusDomain: "invoice",
      eventDate: row.due_date,
      ageDays: computeAgeDays(row.due_date, now),
      ownerOnly: false,
      roleNote: FINANCE_ACTION_CATEGORY_META.invoice_overdue.roleNote,
    });
  }
  return items;
}

async function fetchDuePromises(
  supabase: SupabaseClient,
  companyId: string,
  todayIso: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data, error } = await supabase
    .from("promises_to_pay")
    .select("id, promised_amount, promised_date, invoices(invoice_number), customers(name)")
    .eq("company_id", companyId)
    .eq("status", "open")
    .lte("promised_date", todayIso)
    .order("promised_date", { ascending: true })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`promise_due: ${error.message}`);

  return ((data ?? []) as unknown as PromiseRow[]).map((row) => ({
    id: `promise_due:${row.id}`,
    category: "promise_due" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.promise_due.label,
    entityLabel: row.customers?.name ?? "-",
    referenceNumber: row.invoices?.invoice_number ?? "-",
    amount: row.promised_amount,
    statusCode: "open",
    statusDomain: "promise" as const,
    eventDate: row.promised_date,
    ageDays: computeAgeDays(row.promised_date, now),
    ownerOnly: false,
    roleNote: FINANCE_ACTION_CATEGORY_META.promise_due.roleNote,
  }));
}

async function fetchUnverifiedPayments(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data: receipts, error } = await supabase
    .from("payment_receipts")
    .select("id, amount, received_at, customers(name)")
    .eq("company_id", companyId)
    .order("received_at", { ascending: false })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`payment_unverified: ${error.message}`);

  const rows = (receipts ?? []) as unknown as ReceiptRow[];
  if (rows.length === 0) return [];

  const { data: reconciledRows, error: recErr } = await supabase
    .from("payment_reconciliations")
    .select("payment_receipt_id")
    .in("payment_receipt_id", rows.map((r) => r.id));
  if (recErr) throw new Error(`payment_unverified reconciliations: ${recErr.message}`);

  const reconciledSet = new Set(
    ((reconciledRows ?? []) as { payment_receipt_id: string }[]).map((r) => r.payment_receipt_id)
  );

  return rows
    .filter((r) => !reconciledSet.has(r.id))
    .map((row) => ({
      id: `payment_unverified:${row.id}`,
      category: "payment_unverified" as const,
      categoryLabel: FINANCE_ACTION_CATEGORY_META.payment_unverified.label,
      entityLabel: row.customers?.name ?? "-",
      referenceNumber: row.id.slice(0, 8),
      amount: row.amount,
      statusCode: "pending_verification",
      statusDomain: "payment_reconciliation" as const,
      eventDate: row.received_at,
      ageDays: computeAgeDays(row.received_at, now),
      ownerOnly: false,
      roleNote: FINANCE_ACTION_CATEGORY_META.payment_unverified.roleNote,
    }));
}

async function fetchReconciliationExceptions(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data, error } = await supabase
    .from("payment_reconciliation_exceptions")
    .select("id, payment_receipt_id, customer_id, classification, unallocated_amount, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`reconciliation_exception: ${error.message}`);

  const rows = (data ?? []) as unknown as ReconciliationExceptionRow[];
  if (rows.length === 0) return [];

  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const { data: customerRows, error: custErr } = await supabase
    .from("customers")
    .select("id, name")
    .in("id", customerIds);
  if (custErr) throw new Error(`reconciliation_exception customers: ${custErr.message}`);

  const nameMap = new Map(((customerRows ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));

  return rows.map((row) => ({
    id: `reconciliation_exception:${row.id}`,
    category: "reconciliation_exception" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.reconciliation_exception.label,
    entityLabel: nameMap.get(row.customer_id) ?? "-",
    referenceNumber: row.payment_receipt_id.slice(0, 8),
    amount: row.unallocated_amount,
    statusCode: row.classification,
    statusDomain: "payment_reconciliation" as const,
    eventDate: row.created_at,
    ageDays: computeAgeDays(row.created_at, now),
    ownerOnly: false,
    roleNote: FINANCE_ACTION_CATEGORY_META.reconciliation_exception.roleNote,
  }));
}

async function fetchPendingReturns(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data, error } = await supabase
    .from("returns")
    .select("id, requested_at, invoices(invoice_number), customers(name)")
    .eq("company_id", companyId)
    .eq("status", "requested")
    .order("requested_at", { ascending: true })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`return_pending: ${error.message}`);

  return ((data ?? []) as unknown as ReturnRow[]).map((row) => ({
    id: `return_pending:${row.id}`,
    category: "return_pending" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.return_pending.label,
    entityLabel: row.customers?.name ?? "-",
    referenceNumber: row.invoices?.invoice_number ?? "-",
    amount: null,
    statusCode: "requested",
    statusDomain: "return" as const,
    eventDate: row.requested_at,
    ageDays: computeAgeDays(row.requested_at, now),
    ownerOnly: true,
    roleNote: FINANCE_ACTION_CATEGORY_META.return_pending.roleNote,
  }));
}

async function fetchPendingRefunds(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data, error } = await supabase
    .from("refund_requests")
    .select("id, amount, requested_at, credit_notes(invoices(invoice_number)), customers(name)")
    .eq("company_id", companyId)
    .eq("status", "requested")
    .order("requested_at", { ascending: true })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`refund_pending: ${error.message}`);

  return ((data ?? []) as unknown as RefundRow[]).map((row) => ({
    id: `refund_pending:${row.id}`,
    category: "refund_pending" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.refund_pending.label,
    entityLabel: row.customers?.name ?? "-",
    referenceNumber: row.credit_notes?.invoices?.invoice_number ?? "-",
    amount: row.amount,
    statusCode: "requested",
    statusDomain: "refund" as const,
    eventDate: row.requested_at,
    ageDays: computeAgeDays(row.requested_at, now),
    ownerOnly: true,
    roleNote: FINANCE_ACTION_CATEGORY_META.refund_pending.roleNote,
  }));
}

async function fetchPendingCancellations(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const { data, error } = await supabase
    .from("order_cancellations")
    .select("id, requested_at, sales_orders(order_number, customers(name))")
    .eq("company_id", companyId)
    .eq("status", "requested")
    .order("requested_at", { ascending: true })
    .limit(QUEUE_LIMIT_PER_CATEGORY);
  if (error) throw new Error(`cancellation_pending: ${error.message}`);

  return ((data ?? []) as unknown as CancellationRow[]).map((row) => ({
    id: `cancellation_pending:${row.id}`,
    category: "cancellation_pending" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.cancellation_pending.label,
    entityLabel: row.sales_orders?.customers?.name ?? "-",
    referenceNumber: row.sales_orders?.order_number ?? "-",
    amount: null,
    statusCode: "requested",
    statusDomain: "cancellation" as const,
    eventDate: row.requested_at,
    ageDays: computeAgeDays(row.requested_at, now),
    ownerOnly: true,
    roleNote: FINANCE_ACTION_CATEGORY_META.cancellation_pending.roleNote,
  }));
}

async function fetchInvoiceVoidNotices(
  supabase: SupabaseClient,
  companyId: string,
  now: Date
): Promise<FinanceActionQueueItem[]> {
  const since = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString();

  const [voidsResult, reversalsResult] = await Promise.all([
    supabase
      .from("invoice_voids")
      .select("id, voided_amount, created_at, invoices(invoice_number, customers(name))")
      .eq("company_id", companyId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(QUEUE_LIMIT_PER_CATEGORY),
    supabase
      .from("credit_note_reversals")
      .select("id, reversed_amount, created_at, credit_notes(invoices(invoice_number), customers(name))")
      .eq("company_id", companyId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(QUEUE_LIMIT_PER_CATEGORY),
  ]);

  if (voidsResult.error) throw new Error(`invoice_void_notice voids: ${voidsResult.error.message}`);
  if (reversalsResult.error) throw new Error(`invoice_void_notice reversals: ${reversalsResult.error.message}`);

  const voidItems = ((voidsResult.data ?? []) as unknown as InvoiceVoidRow[]).map((row) => ({
    id: `invoice_void_notice:void:${row.id}`,
    category: "invoice_void_notice" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.invoice_void_notice.label,
    entityLabel: row.invoices?.customers?.name ?? "-",
    referenceNumber: row.invoices?.invoice_number ?? "-",
    amount: row.voided_amount,
    statusCode: "voided",
    statusDomain: "invoice_void" as const,
    eventDate: row.created_at,
    ageDays: computeAgeDays(row.created_at, now),
    ownerOnly: false,
    roleNote: FINANCE_ACTION_CATEGORY_META.invoice_void_notice.roleNote,
  }));

  const reversalItems = ((reversalsResult.data ?? []) as unknown as ReversalRow[]).map((row) => ({
    id: `invoice_void_notice:reversal:${row.id}`,
    category: "invoice_void_notice" as const,
    categoryLabel: FINANCE_ACTION_CATEGORY_META.invoice_void_notice.label,
    entityLabel: row.credit_notes?.customers?.name ?? "-",
    referenceNumber: row.credit_notes?.invoices?.invoice_number ?? "-",
    amount: row.reversed_amount,
    statusCode: "reversed",
    statusDomain: "invoice_void" as const,
    eventDate: row.created_at,
    ageDays: computeAgeDays(row.created_at, now),
    ownerOnly: false,
    roleNote: FINANCE_ACTION_CATEGORY_META.invoice_void_notice.roleNote,
  }));

  return [...voidItems, ...reversalItems];
}

// ---------------------------------------------------------------------------
// Orkestrasi -- satu entry point dipakai halaman Ringkasan.
// ---------------------------------------------------------------------------

export async function getFinanceActionQueue(
  companyId: string,
  client?: SupabaseClient
): Promise<FinanceActionQueueResult> {
  const supabase = client ?? (await createClient());
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);

  const settled = await Promise.allSettled([
    fetchOverdueInvoices(supabase, companyId, todayIso, now),
    fetchReconciliationExceptions(supabase, companyId, now),
    fetchUnverifiedPayments(supabase, companyId, now),
    fetchDuePromises(supabase, companyId, todayIso, now),
    fetchPendingReturns(supabase, companyId, now),
    fetchPendingRefunds(supabase, companyId, now),
    fetchPendingCancellations(supabase, companyId, now),
    fetchInvoiceVoidNotices(supabase, companyId, now),
  ]);

  const items: FinanceActionQueueItem[] = [];
  const failedCategories: FinanceActionCategory[] = [];

  settled.forEach((result, index) => {
    const category = CATEGORY_ORDER[index];
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      failedCategories.push(category);
    }
  });

  return { items: sortActionQueueItems(items), failedCategories };
}
