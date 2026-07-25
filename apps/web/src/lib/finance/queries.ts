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

// =============================================================================
// Gate 2I.2 -- Invoice & Piutang (read-only, kontrak §5.1/§6). Tidak ada
// tombol issuance di sini -- issue_invoice_atomic dipicu alur Delivery
// Verification, bukan workspace ini. Outstanding SELALU dari
// invoice_receivable_balances, tidak pernah dihitung ulang di sini.
// =============================================================================

async function fetchPromiseStatusMap(
  supabase: SupabaseClient,
  invoiceIds: string[]
): Promise<Map<string, "open" | "broken">> {
  if (invoiceIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("promises_to_pay")
    .select("invoice_id, status, created_at")
    .in("invoice_id", invoiceIds)
    .in("status", ["open", "broken"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`promise_status_map: ${error.message}`);
  const map = new Map<string, "open" | "broken">();
  for (const row of (data ?? []) as { invoice_id: string; status: "open" | "broken" }[]) {
    if (!map.has(row.invoice_id)) map.set(row.invoice_id, row.status);
  }
  return map;
}

export interface InvoiceListItem {
  id: string;
  invoiceNumber: string;
  customerName: string;
  issuedAt: string;
  dueDate: string | null;
  totalAmount: number;
  outstandingBalance: number;
  financialStatus: string;
  ageDays: number | null;
  promiseStatus: "open" | "broken" | null;
}

export interface InvoiceListResult {
  items: InvoiceListItem[];
  totalCount: number;
  page: number;
  pageSize: number;
}

const INVOICE_LIST_PAGE_SIZE = 20;

export async function getInvoiceList(
  companyId: string,
  opts: { financialStatus?: string; page?: number } = {},
  client?: SupabaseClient
): Promise<InvoiceListResult> {
  const supabase = client ?? (await createClient());
  const pageSize = INVOICE_LIST_PAGE_SIZE;
  const page = Math.max(1, opts.page ?? 1);

  const { data: balanceRows, error: balErr } = await supabase
    .from("invoice_receivable_balances")
    .select("invoice_id, outstanding_balance, financial_status")
    .eq("company_id", companyId);
  if (balErr) throw new Error(`invoice_list balances: ${balErr.message}`);
  const balanceMap = new Map(
    ((balanceRows ?? []) as { invoice_id: string; outstanding_balance: number; financial_status: string }[]).map(
      (b) => [b.invoice_id, b]
    )
  );

  let filteredIds: string[] | null = null;
  if (opts.financialStatus) {
    filteredIds = [...balanceMap.entries()]
      .filter(([, b]) => b.financial_status === opts.financialStatus)
      .map(([id]) => id);
    if (filteredIds.length === 0) {
      return { items: [], totalCount: 0, page, pageSize };
    }
  }

  let query = supabase
    .from("invoices")
    .select("id, invoice_number, due_date, issued_at, total_amount, customers(name)", { count: "exact" })
    .eq("company_id", companyId);
  if (filteredIds) query = query.in("id", filteredIds);
  query = query
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("invoice_number", { ascending: true })
    .range((page - 1) * pageSize, page * pageSize - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`invoice_list: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    invoice_number: string;
    due_date: string | null;
    issued_at: string;
    total_amount: number;
    customers: { name: string } | null;
  }>;

  const promiseMap = await fetchPromiseStatusMap(
    supabase,
    rows.map((r) => r.id)
  );
  const now = new Date();

  const items: InvoiceListItem[] = rows.map((row) => {
    const balance = balanceMap.get(row.id);
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      customerName: row.customers?.name ?? "-",
      issuedAt: row.issued_at,
      dueDate: row.due_date,
      totalAmount: row.total_amount,
      outstandingBalance: balance?.outstanding_balance ?? row.total_amount,
      financialStatus: balance?.financial_status ?? "outstanding",
      ageDays: computeAgeDays(row.due_date, now),
      promiseStatus: promiseMap.get(row.id) ?? null,
    };
  });

  return { items, totalCount: count ?? 0, page, pageSize };
}

export interface InvoiceDetailLine {
  id: string;
  lineNo: number;
  productName: string;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface InvoiceLedgerEntry {
  id: string;
  entryType: string;
  direction: "debit" | "credit";
  amount: number;
  createdAt: string;
}

export interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  issuedAt: string;
  dueDate: string | null;
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  outstandingBalance: number;
  financialStatus: string;
  totalPaid: number;
  creditNoteReduction: number;
  salesOrderId: string;
  salesOrderNumber: string;
  deliveryId: string;
  promiseStatus: "open" | "broken" | null;
  lines: InvoiceDetailLine[];
  ledger: InvoiceLedgerEntry[];
  paymentReceiptIds: string[];
}

export async function getInvoiceDetail(
  companyId: string,
  invoiceId: string,
  client?: SupabaseClient
): Promise<InvoiceDetail | null> {
  const supabase = client ?? (await createClient());

  const { data: invoiceRow, error: invErr } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, customer_id, due_date, issued_at, subtotal_amount, discount_amount, total_amount, sales_order_id, delivery_id, customers(name), sales_orders(order_number)"
    )
    .eq("company_id", companyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (invErr) throw new Error(`invoice_detail: ${invErr.message}`);
  if (!invoiceRow) return null;

  const inv = invoiceRow as unknown as {
    id: string;
    invoice_number: string;
    customer_id: string;
    due_date: string | null;
    issued_at: string;
    subtotal_amount: number;
    discount_amount: number;
    total_amount: number;
    sales_order_id: string;
    delivery_id: string;
    customers: { name: string } | null;
    sales_orders: { order_number: string } | null;
  };

  const [linesResult, ledgerResult, balanceResult, allocResult, promiseMap] = await Promise.all([
    supabase
      .from("invoice_lines")
      .select("id, line_no, product_name, unit, quantity, unit_price, discount_amount, line_total")
      .eq("invoice_id", invoiceId)
      .order("line_no", { ascending: true }),
    supabase
      .from("receivable_ledger")
      .select("id, entry_type, direction, amount, created_at")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: true }),
    supabase
      .from("invoice_receivable_balances")
      .select("outstanding_balance, financial_status")
      .eq("invoice_id", invoiceId)
      .maybeSingle(),
    supabase.from("payment_allocations").select("payment_receipt_id").eq("invoice_id", invoiceId),
    fetchPromiseStatusMap(supabase, [invoiceId]),
  ]);

  if (linesResult.error) throw new Error(`invoice_detail lines: ${linesResult.error.message}`);
  if (ledgerResult.error) throw new Error(`invoice_detail ledger: ${ledgerResult.error.message}`);
  if (balanceResult.error) throw new Error(`invoice_detail balance: ${balanceResult.error.message}`);
  if (allocResult.error) throw new Error(`invoice_detail allocations: ${allocResult.error.message}`);

  const ledger = ((ledgerResult.data ?? []) as unknown as Array<{
    id: string;
    entry_type: string;
    direction: "debit" | "credit";
    amount: number;
    created_at: string;
  }>).map((l) => ({
    id: l.id,
    entryType: l.entry_type,
    direction: l.direction,
    amount: l.amount,
    createdAt: l.created_at,
  }));

  const totalPaid = ledger
    .filter((l) => l.entryType === "payment_allocation" && l.direction === "credit")
    .reduce((s, l) => s + l.amount, 0);
  const creditNoteReduction =
    ledger.filter((l) => l.entryType === "credit_note" && l.direction === "credit").reduce((s, l) => s + l.amount, 0) -
    ledger
      .filter((l) => l.entryType === "credit_note_reversal" && l.direction === "debit")
      .reduce((s, l) => s + l.amount, 0);

  const balance = balanceResult.data as { outstanding_balance: number; financial_status: string } | null;

  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    customerId: inv.customer_id,
    customerName: inv.customers?.name ?? "-",
    issuedAt: inv.issued_at,
    dueDate: inv.due_date,
    subtotalAmount: inv.subtotal_amount,
    discountAmount: inv.discount_amount,
    totalAmount: inv.total_amount,
    outstandingBalance: balance?.outstanding_balance ?? inv.total_amount,
    financialStatus: balance?.financial_status ?? "outstanding",
    totalPaid,
    creditNoteReduction,
    salesOrderId: inv.sales_order_id,
    salesOrderNumber: inv.sales_orders?.order_number ?? "-",
    deliveryId: inv.delivery_id,
    promiseStatus: promiseMap.get(invoiceId) ?? null,
    lines: ((linesResult.data ?? []) as unknown as Array<{
      id: string;
      line_no: number;
      product_name: string;
      unit: string | null;
      quantity: number;
      unit_price: number;
      discount_amount: number;
      line_total: number;
    }>).map((l) => ({
      id: l.id,
      lineNo: l.line_no,
      productName: l.product_name,
      unit: l.unit,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountAmount: l.discount_amount,
      lineTotal: l.line_total,
    })),
    ledger,
    paymentReceiptIds: [
      ...new Set(((allocResult.data ?? []) as { payment_receipt_id: string }[]).map((a) => a.payment_receipt_id)),
    ],
  };
}

/** Invoice yang layak dipilih untuk membuat janji bayar/mencatat pembayaran baru -- outstanding>0. */
export interface OutstandingInvoiceOption {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  outstandingBalance: number;
  hasOpenPromise: boolean;
}

export async function getOutstandingInvoices(
  companyId: string,
  opts: { customerId?: string } = {},
  client?: SupabaseClient
): Promise<OutstandingInvoiceOption[]> {
  const supabase = client ?? (await createClient());

  const { data: balanceRows, error: balErr } = await supabase
    .from("invoice_receivable_balances")
    .select("invoice_id, outstanding_balance, financial_status")
    .eq("company_id", companyId)
    .in("financial_status", ["outstanding", "partially_paid"]);
  if (balErr) throw new Error(`outstanding_invoices balances: ${balErr.message}`);

  const balanceMap = new Map(
    ((balanceRows ?? []) as { invoice_id: string; outstanding_balance: number }[]).map((b) => [
      b.invoice_id,
      b.outstanding_balance,
    ])
  );
  const ids = [...balanceMap.keys()];
  if (ids.length === 0) return [];

  let query = supabase
    .from("invoices")
    .select("id, invoice_number, customer_id, customers(name)")
    .eq("company_id", companyId)
    .in("id", ids)
    .order("due_date", { ascending: true });
  if (opts.customerId) query = query.eq("customer_id", opts.customerId);

  const { data, error } = await query;
  if (error) throw new Error(`outstanding_invoices: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    invoice_number: string;
    customer_id: string;
    customers: { name: string } | null;
  }>;

  const promiseMap = await fetchPromiseStatusMap(
    supabase,
    rows.map((r) => r.id)
  );

  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    customerId: row.customer_id,
    customerName: row.customers?.name ?? "-",
    outstandingBalance: balanceMap.get(row.id) ?? 0,
    hasOpenPromise: promiseMap.get(row.id) === "open",
  }));
}

// =============================================================================
// Gate 2I.2 -- Collection & Janji Bayar (kontrak §5.2). RPC canonical:
// record_collection_activity, create_promise_to_pay, correct_promise_to_pay,
// cancel_promise_to_pay, mark_promise_broken (migration 20260828000001).
// =============================================================================

export interface PromiseListItem {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  promisedAmount: number;
  promisedDate: string;
  status: string;
  createdAt: string;
  previousPromiseId: string | null;
  reason: string | null;
}

const PROMISE_STATUS_PRIORITY: Record<string, number> = { open: 0, broken: 1, corrected: 2, cancelled: 2 };

export async function getPromiseList(companyId: string, client?: SupabaseClient): Promise<PromiseListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("promises_to_pay")
    .select(
      "id, invoice_id, promised_amount, promised_date, status, created_at, previous_promise_id, reason, invoices(invoice_number), customers(name)"
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`promise_list: ${error.message}`);

  const rows = (
    (data ?? []) as unknown as Array<{
      id: string;
      invoice_id: string;
      promised_amount: number;
      promised_date: string;
      status: string;
      created_at: string;
      previous_promise_id: string | null;
      reason: string | null;
      invoices: { invoice_number: string } | null;
      customers: { name: string } | null;
    }>
  ).map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoices?.invoice_number ?? "-",
    customerName: row.customers?.name ?? "-",
    promisedAmount: row.promised_amount,
    promisedDate: row.promised_date,
    status: row.status,
    createdAt: row.created_at,
    previousPromiseId: row.previous_promise_id,
    reason: row.reason,
  }));

  return rows.sort((a, b) => {
    const pa = PROMISE_STATUS_PRIORITY[a.status] ?? 3;
    const pb = PROMISE_STATUS_PRIORITY[b.status] ?? 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export interface CollectionActivityListItem {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  channel: string;
  activityType: string;
  outcome: string | null;
  reportedAmount: number | null;
  note: string | null;
  occurredAt: string;
}

export async function getCollectionActivityList(
  companyId: string,
  client?: SupabaseClient
): Promise<CollectionActivityListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("collection_activities")
    .select("id, invoice_id, channel, activity_type, outcome, reported_amount, note, occurred_at, invoices(invoice_number), customers(name)")
    .eq("company_id", companyId)
    .order("occurred_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`collection_activity_list: ${error.message}`);

  return ((data ?? []) as unknown as Array<{
    id: string;
    invoice_id: string;
    channel: string;
    activity_type: string;
    outcome: string | null;
    reported_amount: number | null;
    note: string | null;
    occurred_at: string;
    invoices: { invoice_number: string } | null;
    customers: { name: string } | null;
  }>).map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoices?.invoice_number ?? "-",
    customerName: row.customers?.name ?? "-",
    channel: row.channel,
    activityType: row.activity_type,
    outcome: row.outcome,
    reportedAmount: row.reported_amount,
    note: row.note,
    occurredAt: row.occurred_at,
  }));
}

// =============================================================================
// Gate 2I.2 -- Pembayaran & Verifikasi (kontrak §5.3). RPC canonical:
// record_verified_payment_atomic (migration 20260829000001).
// =============================================================================

export interface PaymentReceiptListItem {
  id: string;
  customerName: string;
  method: string;
  amount: number;
  transferReference: string | null;
  receivedAt: string;
  proofCount: number;
  allocationCount: number;
  isReconciled: boolean;
  latestReconciliationClassification: string | null;
}

async function fetchLatestReconciliationMap(
  supabase: SupabaseClient,
  paymentReceiptIds: string[]
): Promise<Map<string, string>> {
  if (paymentReceiptIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("payment_reconciliations")
    .select("payment_receipt_id, classification, created_at")
    .in("payment_receipt_id", paymentReceiptIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`latest_reconciliation_map: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as { payment_receipt_id: string; classification: string }[]) {
    if (!map.has(row.payment_receipt_id)) map.set(row.payment_receipt_id, row.classification);
  }
  return map;
}

export async function getPaymentReceiptList(
  companyId: string,
  client?: SupabaseClient
): Promise<PaymentReceiptListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("payment_receipts")
    .select("id, method, amount, transfer_reference, received_at, customers(name)")
    .eq("company_id", companyId)
    .order("received_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`payment_receipt_list: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    method: string;
    amount: number;
    transfer_reference: string | null;
    received_at: string;
    customers: { name: string } | null;
  }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [proofsResult, allocationsResult, latestReconciliationMap] = await Promise.all([
    supabase.from("payment_proofs").select("payment_receipt_id").in("payment_receipt_id", ids),
    supabase.from("payment_allocations").select("payment_receipt_id").in("payment_receipt_id", ids),
    fetchLatestReconciliationMap(supabase, ids),
  ]);
  if (proofsResult.error) throw new Error(`payment_receipt_list proofs: ${proofsResult.error.message}`);
  if (allocationsResult.error) throw new Error(`payment_receipt_list allocations: ${allocationsResult.error.message}`);

  const countBy = (rows: { payment_receipt_id: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.payment_receipt_id, (m.get(r.payment_receipt_id) ?? 0) + 1);
    return m;
  };
  const proofCounts = countBy((proofsResult.data ?? []) as { payment_receipt_id: string }[]);
  const allocationCounts = countBy((allocationsResult.data ?? []) as { payment_receipt_id: string }[]);

  return rows.map((row) => ({
    id: row.id,
    customerName: row.customers?.name ?? "-",
    method: row.method,
    amount: row.amount,
    transferReference: row.transfer_reference,
    receivedAt: row.received_at,
    proofCount: proofCounts.get(row.id) ?? 0,
    allocationCount: allocationCounts.get(row.id) ?? 0,
    isReconciled: latestReconciliationMap.has(row.id),
    latestReconciliationClassification: latestReconciliationMap.get(row.id) ?? null,
  }));
}

export interface PaymentReceiptDetail {
  id: string;
  customerId: string;
  customerName: string;
  method: string;
  amount: number;
  transferReference: string | null;
  receivedAt: string;
  proofs: Array<{ id: string; proofType: string; objectReference: string }>;
  allocations: Array<{ id: string; invoiceId: string; invoiceNumber: string; amount: number }>;
  reconciliationCount: number;
}

export async function getPaymentReceiptDetail(
  companyId: string,
  paymentReceiptId: string,
  client?: SupabaseClient
): Promise<PaymentReceiptDetail | null> {
  const supabase = client ?? (await createClient());

  const { data: receiptRow, error: receiptErr } = await supabase
    .from("payment_receipts")
    .select("id, customer_id, method, amount, transfer_reference, received_at, customers(name)")
    .eq("company_id", companyId)
    .eq("id", paymentReceiptId)
    .maybeSingle();
  if (receiptErr) throw new Error(`payment_receipt_detail: ${receiptErr.message}`);
  if (!receiptRow) return null;

  const receipt = receiptRow as unknown as {
    id: string;
    customer_id: string;
    method: string;
    amount: number;
    transfer_reference: string | null;
    received_at: string;
    customers: { name: string } | null;
  };

  const [proofsResult, allocationsResult, reconciliationCountResult] = await Promise.all([
    supabase.from("payment_proofs").select("id, proof_type, object_reference").eq("payment_receipt_id", paymentReceiptId),
    supabase
      .from("payment_allocations")
      .select("id, invoice_id, amount, invoices(invoice_number)")
      .eq("payment_receipt_id", paymentReceiptId),
    supabase
      .from("payment_reconciliations")
      .select("id", { count: "exact", head: true })
      .eq("payment_receipt_id", paymentReceiptId),
  ]);
  if (proofsResult.error) throw new Error(`payment_receipt_detail proofs: ${proofsResult.error.message}`);
  if (allocationsResult.error) throw new Error(`payment_receipt_detail allocations: ${allocationsResult.error.message}`);
  if (reconciliationCountResult.error)
    throw new Error(`payment_receipt_detail reconciliation count: ${reconciliationCountResult.error.message}`);

  return {
    id: receipt.id,
    customerId: receipt.customer_id,
    customerName: receipt.customers?.name ?? "-",
    method: receipt.method,
    amount: receipt.amount,
    transferReference: receipt.transfer_reference,
    receivedAt: receipt.received_at,
    proofs: ((proofsResult.data ?? []) as unknown as Array<{ id: string; proof_type: string; object_reference: string }>).map(
      (p) => ({ id: p.id, proofType: p.proof_type, objectReference: p.object_reference })
    ),
    allocations: ((allocationsResult.data ?? []) as unknown as Array<{
      id: string;
      invoice_id: string;
      amount: number;
      invoices: { invoice_number: string } | null;
    }>).map((a) => ({
      id: a.id,
      invoiceId: a.invoice_id,
      invoiceNumber: a.invoices?.invoice_number ?? "-",
      amount: a.amount,
    })),
    reconciliationCount: reconciliationCountResult.count ?? 0,
  };
}

export interface CustomerWithOutstandingOption {
  id: string;
  name: string;
}

export async function getCustomersWithOutstanding(
  companyId: string,
  client?: SupabaseClient
): Promise<CustomerWithOutstandingOption[]> {
  const supabase = client ?? (await createClient());
  const { data: balanceRows, error: balErr } = await supabase
    .from("invoice_receivable_balances")
    .select("invoice_id")
    .eq("company_id", companyId)
    .in("financial_status", ["outstanding", "partially_paid"]);
  if (balErr) throw new Error(`customers_with_outstanding balances: ${balErr.message}`);
  const invoiceIds = ((balanceRows ?? []) as { invoice_id: string }[]).map((b) => b.invoice_id);
  if (invoiceIds.length === 0) return [];

  const { data, error } = await supabase
    .from("invoices")
    .select("customer_id, customers(name)")
    .eq("company_id", companyId)
    .in("id", invoiceIds);
  if (error) throw new Error(`customers_with_outstanding: ${error.message}`);

  const seen = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Array<{ customer_id: string; customers: { name: string } | null }>) {
    if (!seen.has(row.customer_id)) seen.set(row.customer_id, row.customers?.name ?? "-");
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// =============================================================================
// Gate 2I.2 -- Exception Rekonsiliasi (kontrak §5.4). RPC canonical:
// reconcile_verified_payment, correct_payment_reconciliation (migration
// 20260830000001). List selalu dari view payment_reconciliation_exceptions
// (latest-state projection, classification != matched) -- history penuh
// per payment_receipt_id tetap dibaca dari payment_reconciliations (append-only).
// =============================================================================

export interface ReconciliationExceptionListItem {
  id: string;
  paymentReceiptId: string;
  customerName: string;
  classification: string;
  paymentAmount: number;
  totalAllocated: number;
  unallocatedAmount: number;
  createdAt: string;
}

export async function getReconciliationExceptionList(
  companyId: string,
  client?: SupabaseClient
): Promise<ReconciliationExceptionListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("payment_reconciliation_exceptions")
    .select("id, payment_receipt_id, customer_id, classification, payment_amount, total_allocated, unallocated_amount, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`reconciliation_exception_list: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    payment_receipt_id: string;
    customer_id: string;
    classification: string;
    payment_amount: number;
    total_allocated: number;
    unallocated_amount: number;
    created_at: string;
  }>;
  if (rows.length === 0) return [];

  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const { data: customerRows, error: custErr } = await supabase.from("customers").select("id, name").in("id", customerIds);
  if (custErr) throw new Error(`reconciliation_exception_list customers: ${custErr.message}`);
  const nameMap = new Map(((customerRows ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));

  return rows.map((row) => ({
    id: row.id,
    paymentReceiptId: row.payment_receipt_id,
    customerName: nameMap.get(row.customer_id) ?? "-",
    classification: row.classification,
    paymentAmount: row.payment_amount,
    totalAllocated: row.total_allocated,
    unallocatedAmount: row.unallocated_amount,
    createdAt: row.created_at,
  }));
}

export interface ReconciliationHistoryEntry {
  id: string;
  classification: string;
  paymentAmount: number;
  totalAllocated: number;
  unallocatedAmount: number;
  method: string;
  previousReconciliationId: string | null;
  reason: string | null;
  createdAt: string;
}

export async function getReconciliationHistory(
  companyId: string,
  paymentReceiptId: string,
  client?: SupabaseClient
): Promise<ReconciliationHistoryEntry[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("payment_reconciliations")
    .select(
      "id, classification, payment_amount, total_allocated, unallocated_amount, method, previous_reconciliation_id, reason, created_at"
    )
    .eq("company_id", companyId)
    .eq("payment_receipt_id", paymentReceiptId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`reconciliation_history: ${error.message}`);

  return ((data ?? []) as unknown as Array<{
    id: string;
    classification: string;
    payment_amount: number;
    total_allocated: number;
    unallocated_amount: number;
    method: string;
    previous_reconciliation_id: string | null;
    reason: string | null;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    classification: row.classification,
    paymentAmount: row.payment_amount,
    totalAllocated: row.total_allocated,
    unallocatedAmount: row.unallocated_amount,
    method: row.method,
    previousReconciliationId: row.previous_reconciliation_id,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

// =============================================================================
// Gate 2I.3 -- Retur & Credit Note (kontrak §5.5/§6/§8). RPC canonical:
// request_return_atomic, verify_return_atomic (migration 20260831000001).
// Nilai retur pra-approval SELALU dihitung dari invoice_lines immutable
// dengan formula IDENTIK verify_return_atomic (requested_quantity *
// line_total/quantity, lalu LEAST(total, outstanding)) -- ini "preview" yang
// kontrak §5.5 wajibkan tampil sebelum approve, BUKAN penghitungan ulang
// alternatif (angka final pasca approval SELALU dibaca dari credit_notes,
// tidak pernah dari preview ini).
// =============================================================================

export interface ReturnListItem {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  reasonCode: string;
  requestedAt: string;
  decidedAt: string | null;
  creditNoteId: string | null;
  creditNoteTotalAmount: number | null;
}

const RETURN_STATUS_PRIORITY: Record<string, number> = { requested: 0, approved: 1, rejected: 1 };

interface ReturnRowRaw {
  id: string;
  invoice_id: string;
  status: string;
  reason_code: string;
  requested_at: string;
  decided_at: string | null;
  invoices: { invoice_number: string } | null;
  customers: { name: string } | null;
}

async function mapReturnRows(supabase: SupabaseClient, rows: ReturnRowRaw[]): Promise<ReturnListItem[]> {
  if (rows.length === 0) return [];
  const { data: creditNoteRows, error: cnErr } = await supabase
    .from("credit_notes")
    .select("id, return_id, total_amount")
    .in("return_id", rows.map((r) => r.id));
  if (cnErr) throw new Error(`return_credit_note_map: ${cnErr.message}`);
  const creditNoteMap = new Map(
    ((creditNoteRows ?? []) as { id: string; return_id: string; total_amount: number }[]).map((c) => [c.return_id, c])
  );
  return rows.map((row) => ({
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoices?.invoice_number ?? "-",
    customerName: row.customers?.name ?? "-",
    status: row.status,
    reasonCode: row.reason_code,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    creditNoteId: creditNoteMap.get(row.id)?.id ?? null,
    creditNoteTotalAmount: creditNoteMap.get(row.id)?.total_amount ?? null,
  }));
}

const RETURN_ROW_SELECT =
  "id, invoice_id, status, reason_code, requested_at, decided_at, invoices(invoice_number), customers(name)";

export async function getReturnList(companyId: string, client?: SupabaseClient): Promise<ReturnListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("returns")
    .select(RETURN_ROW_SELECT)
    .eq("company_id", companyId)
    .order("requested_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`return_list: ${error.message}`);

  const items = await mapReturnRows(supabase, (data ?? []) as unknown as ReturnRowRaw[]);
  return items.sort((a, b) => {
    const pa = RETURN_STATUS_PRIORITY[a.status] ?? 2;
    const pb = RETURN_STATUS_PRIORITY[b.status] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
  });
}

/** Retur untuk satu invoice tertentu -- dipakai section "Retur & Credit Note" di halaman detail invoice (kontrak §6 "link ke return/credit note terkait"). */
export async function getReturnsForInvoice(
  companyId: string,
  invoiceId: string,
  client?: SupabaseClient
): Promise<ReturnListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("returns")
    .select(RETURN_ROW_SELECT)
    .eq("company_id", companyId)
    .eq("invoice_id", invoiceId)
    .order("requested_at", { ascending: false });
  if (error) throw new Error(`returns_for_invoice: ${error.message}`);
  return mapReturnRows(supabase, (data ?? []) as unknown as ReturnRowRaw[]);
}

export interface ReturnDetailItem {
  id: string;
  invoiceLineId: string;
  productName: string;
  unit: string | null;
  invoicedQuantity: number;
  requestedQuantity: number;
  lineAmountPreview: number;
}

export interface ReturnDetail {
  id: string;
  status: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  reasonCode: string;
  proofReference: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  outstandingBalance: number;
  items: ReturnDetailItem[];
  totalPreview: number;
  appliedAmountPreview: number;
  customerCreditAmountPreview: number;
  creditNote: {
    id: string;
    totalAmount: number;
    appliedAmount: number;
    customerCreditAmount: number;
    createdAt: string;
  } | null;
}

export async function getReturnDetail(
  companyId: string,
  returnId: string,
  client?: SupabaseClient
): Promise<ReturnDetail | null> {
  const supabase = client ?? (await createClient());

  const { data: returnRow, error: returnErr } = await supabase
    .from("returns")
    .select(
      "id, status, invoice_id, customer_id, reason_code, proof_reference, requested_at, decided_at, requested_by, decided_by, invoices(invoice_number), customers(name)"
    )
    .eq("company_id", companyId)
    .eq("id", returnId)
    .maybeSingle();
  if (returnErr) throw new Error(`return_detail: ${returnErr.message}`);
  if (!returnRow) return null;

  const ret = returnRow as unknown as {
    id: string;
    status: string;
    invoice_id: string;
    customer_id: string;
    reason_code: string;
    proof_reference: string;
    requested_at: string;
    decided_at: string | null;
    requested_by: string;
    decided_by: string | null;
    invoices: { invoice_number: string } | null;
    customers: { name: string } | null;
  };

  const [itemsResult, balanceResult, creditNoteResult, actorRows] = await Promise.all([
    supabase
      .from("return_items")
      .select("id, invoice_line_id, requested_quantity, invoice_lines(product_name, unit, quantity, line_total)")
      .eq("return_id", returnId),
    supabase.from("invoice_receivable_balances").select("outstanding_balance").eq("invoice_id", ret.invoice_id).maybeSingle(),
    supabase
      .from("credit_notes")
      .select("id, total_amount, applied_amount, customer_credit_amount, created_at")
      .eq("return_id", returnId)
      .maybeSingle(),
    supabase
      .from("users")
      .select("id, full_name")
      .in("id", [ret.requested_by, ret.decided_by].filter((v): v is string => Boolean(v))),
  ]);

  if (itemsResult.error) throw new Error(`return_detail items: ${itemsResult.error.message}`);
  if (balanceResult.error) throw new Error(`return_detail balance: ${balanceResult.error.message}`);
  if (creditNoteResult.error) throw new Error(`return_detail credit_note: ${creditNoteResult.error.message}`);
  if (actorRows.error) throw new Error(`return_detail actors: ${actorRows.error.message}`);

  const nameMap = new Map(((actorRows.data ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));

  const items: ReturnDetailItem[] = ((itemsResult.data ?? []) as unknown as Array<{
    id: string;
    invoice_line_id: string;
    requested_quantity: number;
    invoice_lines: { product_name: string; unit: string | null; quantity: number; line_total: number } | null;
  }>).map((row) => {
    const qty = row.invoice_lines?.quantity ?? 0;
    const lineTotal = row.invoice_lines?.line_total ?? 0;
    const lineAmountPreview = qty > 0 ? Math.round(row.requested_quantity * (lineTotal / qty) * 100) / 100 : 0;
    return {
      id: row.id,
      invoiceLineId: row.invoice_line_id,
      productName: row.invoice_lines?.product_name ?? "-",
      unit: row.invoice_lines?.unit ?? null,
      invoicedQuantity: qty,
      requestedQuantity: row.requested_quantity,
      lineAmountPreview,
    };
  });

  const totalPreview = items.reduce((s, i) => s + i.lineAmountPreview, 0);
  const outstandingBalance = (balanceResult.data as { outstanding_balance: number } | null)?.outstanding_balance ?? 0;
  const appliedAmountPreview = Math.min(totalPreview, outstandingBalance);
  const customerCreditAmountPreview = totalPreview - appliedAmountPreview;

  const cn = creditNoteResult.data as {
    id: string;
    total_amount: number;
    applied_amount: number;
    customer_credit_amount: number;
    created_at: string;
  } | null;

  return {
    id: ret.id,
    status: ret.status,
    invoiceId: ret.invoice_id,
    invoiceNumber: ret.invoices?.invoice_number ?? "-",
    customerId: ret.customer_id,
    customerName: ret.customers?.name ?? "-",
    reasonCode: ret.reason_code,
    proofReference: ret.proof_reference,
    requestedByName: nameMap.get(ret.requested_by) ?? "-",
    requestedAt: ret.requested_at,
    decidedByName: ret.decided_by ? nameMap.get(ret.decided_by) ?? "-" : null,
    decidedAt: ret.decided_at,
    outstandingBalance,
    items,
    totalPreview,
    appliedAmountPreview,
    customerCreditAmountPreview,
    creditNote: cn
      ? {
          id: cn.id,
          totalAmount: cn.total_amount,
          appliedAmount: cn.applied_amount,
          customerCreditAmount: cn.customer_credit_amount,
          createdAt: cn.created_at,
        }
      : null,
  };
}

// =============================================================================
// Gate 2I.3 -- Customer Credit & Refund (kontrak §5.6/§8). RPC canonical:
// request_refund_atomic, approve_refund_atomic (migration 20260902000001).
// Saldo SELALU dibaca dari view customer_credit_balances -- tidak pernah
// dihitung ulang di sini (kontrak §8 "jangan membuat formula saldo
// alternatif di frontend").
// =============================================================================

export interface CreditNoteListItem {
  id: string;
  returnId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerCreditAmount: number;
  /**
   * FALSE selama origin credit (customer_credit_ledger entry_type=credit_note_origin)
   * belum dibuat LAZY oleh request_refund_atomic/reverse_credit_note_atomic (Gate 2H
   * migration 20260902000001, bagian "G"). Ditentukan dari KEBERADAAN baris nyata di
   * customer_credit_ledger -- BUKAN ditebak dari nilai ledgerBalance/availableBalance
   * (keduanya sama-sama 0 baik saat belum diinisialisasi MAUPUN saat canonical zero
   * setelah saldo habis terpakai -- dua state itu tidak bisa dibedakan dari angka view
   * saja). Saat FALSE, ledgerBalance/pendingReserved/availableBalance di bawah berasal
   * dari COALESCE(...,0) pada view (bukan nilai final "habis") -- UI wajib menampilkan
   * label eksplisit "belum diinisialisasi", bukan Rp0 seolah saldo sudah terpakai.
   */
  isInitialized: boolean;
  ledgerBalance: number;
  pendingReserved: number;
  availableBalance: number;
  isReversed: boolean;
  createdAt: string;
}

export async function getCreditNoteList(companyId: string, client?: SupabaseClient): Promise<CreditNoteListItem[]> {
  const supabase = client ?? (await createClient());
  const { data: creditNoteRows, error } = await supabase
    .from("credit_notes")
    .select("id, return_id, invoice_id, customer_id, customer_credit_amount, created_at, invoices(invoice_number), customers(name)")
    .eq("company_id", companyId)
    .gt("customer_credit_amount", 0)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`credit_note_list: ${error.message}`);

  const rows = (creditNoteRows ?? []) as unknown as Array<{
    id: string;
    return_id: string;
    invoice_id: string;
    customer_id: string;
    customer_credit_amount: number;
    created_at: string;
    invoices: { invoice_number: string } | null;
    customers: { name: string } | null;
  }>;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [balancesResult, reversalsResult, ledgerExistsResult] = await Promise.all([
    supabase.from("customer_credit_balances").select("credit_note_id, ledger_balance, pending_reserved, available_balance").in("credit_note_id", ids),
    supabase.from("credit_note_reversals").select("credit_note_id").in("credit_note_id", ids),
    supabase.from("customer_credit_ledger").select("credit_note_id").in("credit_note_id", ids).eq("entry_type", "credit_note_origin"),
  ]);
  if (balancesResult.error) throw new Error(`credit_note_list balances: ${balancesResult.error.message}`);
  if (reversalsResult.error) throw new Error(`credit_note_list reversals: ${reversalsResult.error.message}`);
  if (ledgerExistsResult.error) throw new Error(`credit_note_list ledger existence: ${ledgerExistsResult.error.message}`);

  const balanceMap = new Map(
    ((balancesResult.data ?? []) as { credit_note_id: string; ledger_balance: number; pending_reserved: number; available_balance: number }[]).map(
      (b) => [b.credit_note_id, b]
    )
  );
  const reversedSet = new Set(((reversalsResult.data ?? []) as { credit_note_id: string }[]).map((r) => r.credit_note_id));
  const initializedSet = new Set(((ledgerExistsResult.data ?? []) as { credit_note_id: string }[]).map((r) => r.credit_note_id));

  return rows.map((row) => {
    const balance = balanceMap.get(row.id);
    const isInitialized = initializedSet.has(row.id);
    return {
      id: row.id,
      returnId: row.return_id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoices?.invoice_number ?? "-",
      customerId: row.customer_id,
      customerName: row.customers?.name ?? "-",
      customerCreditAmount: row.customer_credit_amount,
      isInitialized,
      ledgerBalance: balance?.ledger_balance ?? 0,
      pendingReserved: balance?.pending_reserved ?? 0,
      availableBalance: balance?.available_balance ?? 0,
      isReversed: reversedSet.has(row.id),
      createdAt: row.created_at,
    };
  });
}

export interface RefundListItem {
  id: string;
  creditNoteId: string;
  invoiceNumber: string;
  customerName: string;
  amount: number;
  method: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
}

const REFUND_STATUS_PRIORITY: Record<string, number> = { requested: 0, approved: 1, rejected: 1 };

export async function getRefundList(companyId: string, client?: SupabaseClient): Promise<RefundListItem[]> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from("refund_requests")
    .select("id, credit_note_id, amount, method, status, requested_at, decided_at, credit_notes(invoices(invoice_number)), customers(name)")
    .eq("company_id", companyId)
    .order("requested_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`refund_list: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    credit_note_id: string;
    amount: number;
    method: string;
    status: string;
    requested_at: string;
    decided_at: string | null;
    credit_notes: { invoices: { invoice_number: string } | null } | null;
    customers: { name: string } | null;
  }>;

  return rows
    .map((row) => ({
      id: row.id,
      creditNoteId: row.credit_note_id,
      invoiceNumber: row.credit_notes?.invoices?.invoice_number ?? "-",
      customerName: row.customers?.name ?? "-",
      amount: row.amount,
      method: row.method,
      status: row.status,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
    }))
    .sort((a, b) => {
      const pa = REFUND_STATUS_PRIORITY[a.status] ?? 2;
      const pb = REFUND_STATUS_PRIORITY[b.status] ?? 2;
      if (pa !== pb) return pa - pb;
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    });
}

export interface RefundDetail {
  id: string;
  status: string;
  creditNoteId: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  amount: number;
  method: string;
  proofReference: string;
  transactionDate: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  creditNoteCustomerCreditAmount: number;
  ledgerBalance: number;
  pendingReserved: number;
  availableBalance: number;
  isReversed: boolean;
}

export async function getRefundDetail(companyId: string, refundId: string, client?: SupabaseClient): Promise<RefundDetail | null> {
  const supabase = client ?? (await createClient());
  const { data: refundRow, error: refundErr } = await supabase
    .from("refund_requests")
    .select(
      "id, status, credit_note_id, customer_id, amount, method, proof_reference, transaction_date, requested_at, decided_at, requested_by, decided_by, credit_notes(invoice_id, customer_credit_amount, invoices(invoice_number)), customers(name)"
    )
    .eq("company_id", companyId)
    .eq("id", refundId)
    .maybeSingle();
  if (refundErr) throw new Error(`refund_detail: ${refundErr.message}`);
  if (!refundRow) return null;

  const r = refundRow as unknown as {
    id: string;
    status: string;
    credit_note_id: string;
    customer_id: string;
    amount: number;
    method: string;
    proof_reference: string;
    transaction_date: string;
    requested_at: string;
    decided_at: string | null;
    requested_by: string;
    decided_by: string | null;
    credit_notes: { invoice_id: string; customer_credit_amount: number; invoices: { invoice_number: string } | null } | null;
    customers: { name: string } | null;
  };

  const [balanceResult, reversalResult, actorRows] = await Promise.all([
    supabase
      .from("customer_credit_balances")
      .select("ledger_balance, pending_reserved, available_balance")
      .eq("credit_note_id", r.credit_note_id)
      .maybeSingle(),
    supabase.from("credit_note_reversals").select("id").eq("credit_note_id", r.credit_note_id).maybeSingle(),
    supabase
      .from("users")
      .select("id, full_name")
      .in("id", [r.requested_by, r.decided_by].filter((v): v is string => Boolean(v))),
  ]);
  if (balanceResult.error) throw new Error(`refund_detail balance: ${balanceResult.error.message}`);
  if (reversalResult.error) throw new Error(`refund_detail reversal: ${reversalResult.error.message}`);
  if (actorRows.error) throw new Error(`refund_detail actors: ${actorRows.error.message}`);

  const nameMap = new Map(((actorRows.data ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));
  const balance = balanceResult.data as { ledger_balance: number; pending_reserved: number; available_balance: number } | null;

  return {
    id: r.id,
    status: r.status,
    creditNoteId: r.credit_note_id,
    invoiceId: r.credit_notes?.invoice_id ?? "",
    invoiceNumber: r.credit_notes?.invoices?.invoice_number ?? "-",
    customerId: r.customer_id,
    customerName: r.customers?.name ?? "-",
    amount: r.amount,
    method: r.method,
    proofReference: r.proof_reference,
    transactionDate: r.transaction_date,
    requestedByName: nameMap.get(r.requested_by) ?? "-",
    requestedAt: r.requested_at,
    decidedByName: r.decided_by ? nameMap.get(r.decided_by) ?? "-" : null,
    decidedAt: r.decided_at,
    creditNoteCustomerCreditAmount: r.credit_notes?.customer_credit_amount ?? 0,
    ledgerBalance: balance?.ledger_balance ?? 0,
    pendingReserved: balance?.pending_reserved ?? 0,
    availableBalance: balance?.available_balance ?? 0,
    isReversed: Boolean(reversalResult.data),
  };
}
