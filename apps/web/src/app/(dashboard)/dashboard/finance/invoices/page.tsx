// =============================================================================
// Gate 2I.2 -- Invoice & Piutang: list (kontrak §5.1/§6). READ-ONLY -- tidak
// ada tombol issuance di sini (issue_invoice_atomic dipicu alur Delivery
// Verification, bukan workspace ini). Outstanding SELALU dari
// invoice_receivable_balances (getInvoiceList), tidak pernah dihitung ulang.
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getInvoiceList, hasFinanceWorkspaceAccess, type InvoiceListItem } from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { FinanceStatusFilter } from "@/components/finance/finance-status-filter";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Invoice & Piutang — AODP" };

const STATUS_FILTER_OPTIONS = [
  { label: "Semua", value: "" },
  { label: "Belum Dibayar", value: "outstanding" },
  { label: "Dibayar Sebagian", value: "partially_paid" },
  { label: "Lunas", value: "paid" },
];

interface SearchParams {
  status?: string;
  page?: string;
}

const columns: Column<InvoiceListItem>[] = [
  {
    key: "invoiceNumber",
    label: "No. Invoice",
    render: (row) => (
      <Link
        href={`/dashboard/finance/invoices/${row.id}`}
        className="font-mono text-xs font-semibold text-blue-600 hover:underline"
      >
        {row.invoiceNumber}
      </Link>
    ),
  },
  { key: "customerName", label: "Customer" },
  {
    key: "issuedAt",
    label: "Tgl. Terbit",
    render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.issuedAt)}</span>,
  },
  {
    key: "dueDate",
    label: "Jatuh Tempo",
    render: (row) => (
      <div>
        <span className="text-xs text-gray-600">{row.dueDate ? formatJakartaDateTime(row.dueDate) : "—"}</span>
        {row.ageDays != null && row.financialStatus !== "paid" && (
          <p className="text-xs text-gray-400">{row.ageDays} hari</p>
        )}
      </div>
    ),
  },
  { key: "totalAmount", label: "Nilai Invoice", align: "right", render: (row) => formatRupiah(row.totalAmount) },
  {
    key: "outstandingBalance",
    label: "Outstanding",
    align: "right",
    render: (row) => <span className="font-semibold text-gray-900">{formatRupiah(row.outstandingBalance)}</span>,
  },
  {
    key: "financialStatus",
    label: "Status",
    render: (row) => <StatusBadge status={row.financialStatus} domain="invoice" />,
  },
  {
    key: "promiseStatus",
    label: "Collection",
    render: (row) =>
      row.promiseStatus ? (
        <StatusBadge status={row.promiseStatus} domain="promise" />
      ) : (
        <span className="text-xs text-gray-400">—</span>
      ),
  },
];

function InvoiceCard({ item }: { item: InvoiceListItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/dashboard/finance/invoices/${item.id}`} className="font-mono text-sm font-semibold text-blue-600 hover:underline">
            {item.invoiceNumber}
          </Link>
          <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
        </div>
        <StatusBadge status={item.financialStatus} domain="invoice" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Nilai Invoice</dt>
          <dd className="font-medium text-gray-800">{formatRupiah(item.totalAmount)}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Outstanding</dt>
          <dd className="font-semibold text-gray-900">{formatRupiah(item.outstandingBalance)}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Jatuh Tempo</dt>
          <dd className="text-gray-700">{item.dueDate ? formatJakartaDateTime(item.dueDate) : "—"}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Collection</dt>
          <dd>{item.promiseStatus ? <StatusBadge status={item.promiseStatus} domain="promise" /> : "—"}</dd>
        </div>
      </dl>
    </li>
  );
}

function PaginationLink({
  page,
  status,
  label,
  isActive,
}: {
  page: number;
  status?: string;
  label: string;
  isActive?: boolean;
}) {
  const sp = new URLSearchParams();
  if (status) sp.set("status", status);
  sp.set("page", String(page));
  return (
    <Link
      href={`/dashboard/finance/invoices?${sp.toString()}`}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium ${
        isActive ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function InvoiceListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Invoice & Piutang membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const status = params.status || undefined;

  let result: Awaited<ReturnType<typeof getInvoiceList>> | null = null;
  let loadError = false;
  try {
    result = await getInvoiceList(user.company_id, { financialStatus: status, page });
  } catch {
    loadError = true;
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.totalCount / result.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <PageHeader title="Invoice & Piutang" subtitle="Daftar invoice yang sudah terbit beserta status piutangnya." />

      <FinanceStatusFilter options={STATUS_FILTER_OPTIONS} />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar invoice</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : result && result.items.length === 0 ? (
        <EmptyState
          title="Belum ada invoice"
          description="Invoice akan muncul di sini setelah diterbitkan lewat alur Delivery Verification."
        />
      ) : (
        result && (
          <>
            <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
              <DataTable<InvoiceListItem> columns={columns} data={result.items} keyExtractor={(row) => row.id} />
            </div>
            <ul className="space-y-2 md:hidden">
              {result.items.map((item) => (
                <InvoiceCard key={item.id} item={item} />
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  Halaman {result.page} dari {totalPages} ({result.totalCount.toLocaleString("id-ID")} invoice)
                </p>
                <div className="flex gap-1">
                  {result.page > 1 && <PaginationLink page={result.page - 1} status={status} label="← Sebelumnya" />}
                  {result.page < totalPages && <PaginationLink page={result.page + 1} status={status} label="Berikutnya →" />}
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
