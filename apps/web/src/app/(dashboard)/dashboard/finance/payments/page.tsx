// =============================================================================
// Gate 2I.2 -- Pembayaran & Verifikasi: list (kontrak §5.3).
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getCustomersWithOutstanding,
  getOutstandingInvoices,
  getPaymentReceiptList,
  hasFinanceWorkspaceAccess,
  type PaymentReceiptListItem,
} from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { RecordPaymentPanel } from "@/components/finance/record-payment-panel";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Pembayaran & Verifikasi — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

const columns: Column<PaymentReceiptListItem>[] = [
  {
    key: "id",
    label: "Referensi",
    render: (row) => (
      <Link href={`/dashboard/finance/payments/${row.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">
        {row.id.slice(0, 8)}…
      </Link>
    ),
  },
  { key: "customerName", label: "Customer" },
  { key: "method", label: "Metode", render: (row) => METHOD_LABELS[row.method] ?? row.method },
  { key: "amount", label: "Nominal", align: "right", render: (row) => formatRupiah(row.amount) },
  {
    key: "receivedAt",
    label: "Diterima",
    render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.receivedAt)}</span>,
  },
  { key: "allocationCount", label: "Alokasi", align: "center", render: (row) => row.allocationCount },
  {
    key: "status",
    label: "Status Rekonsiliasi",
    render: (row) => (
      <StatusBadge
        status={row.latestReconciliationClassification ?? "pending_verification"}
        domain="payment_reconciliation"
      />
    ),
  },
];

export default async function PaymentListPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Pembayaran & Verifikasi membaca dan mengubah data finansial nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  let receipts: PaymentReceiptListItem[] = [];
  let customers: Awaited<ReturnType<typeof getCustomersWithOutstanding>> = [];
  let outstandingInvoices: Awaited<ReturnType<typeof getOutstandingInvoices>> = [];
  let loadError = false;
  try {
    [receipts, customers, outstandingInvoices] = await Promise.all([
      getPaymentReceiptList(user.company_id),
      getCustomersWithOutstanding(user.company_id),
      getOutstandingInvoices(user.company_id),
    ]);
  } catch {
    loadError = true;
  }

  const canRecord = hasPermission(user.permissions, "payment.record");

  return (
    <div className="space-y-4">
      <PageHeader title="Pembayaran & Verifikasi" subtitle="Pembayaran terverifikasi yang sudah dicatat beserta alokasinya.">
        <RecordPaymentPanel customers={customers} outstandingInvoices={outstandingInvoices} canRecord={canRecord} />
      </PageHeader>

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar pembayaran</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : receipts.length === 0 ? (
        <EmptyState title="Belum ada pembayaran tercatat" description="Pembayaran akan muncul di sini setelah dicatat." />
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white">
          <DataTable<PaymentReceiptListItem> columns={columns} data={receipts} keyExtractor={(row) => row.id} />
        </div>
      )}
    </div>
  );
}
