// =============================================================================
// Gate 2I.2 -- Invoice & Piutang: list (kontrak §5.1/§6). READ-ONLY -- tidak
// ada tombol issuance di sini (issue_invoice_atomic dipicu alur Delivery
// Verification, bukan workspace ini). Outstanding SELALU dari
// invoice_receivable_balances (getInvoiceList), tidak pernah dihitung ulang.
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getInvoiceList, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { FinanceStatusFilter } from "@/components/finance/finance-status-filter";
import { InvoiceSelectionTable } from "@/components/finance/invoice-selection-table";

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
            <InvoiceSelectionTable items={result.items} />

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
