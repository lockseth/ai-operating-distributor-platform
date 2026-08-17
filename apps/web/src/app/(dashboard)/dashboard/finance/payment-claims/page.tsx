// =============================================================================
// Gate P4.06 -- Klaim Pembayaran: antrian review Owner/Finance. Klaim PENDING
// ditampilkan dulu (perlu tindakan), lalu riwayat APPROVED/REJECTED di bawahnya.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getOutstandingInvoices,
  getPaymentClaimList,
  hasFinanceWorkspaceAccess,
  type PaymentClaimListItem,
} from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { PaymentClaimReviewPanel } from "@/components/finance/payment-claim-review-panel";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Klaim Pembayaran — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

export default async function PaymentClaimsPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Klaim Pembayaran membaca dan mengubah data finansial nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  const canDecide = hasPermission(user.permissions, "payment.record");

  let claims: PaymentClaimListItem[] = [];
  let outstandingInvoices: Awaited<ReturnType<typeof getOutstandingInvoices>> = [];
  let loadError = false;
  try {
    [claims, outstandingInvoices] = await Promise.all([
      getPaymentClaimList(user.company_id),
      getOutstandingInvoices(user.company_id),
    ]);
  } catch {
    loadError = true;
  }

  const pending = claims.filter((c) => c.status === "PENDING");
  const decided = claims.filter((c) => c.status !== "PENDING");

  const baseColumns: Column<PaymentClaimListItem>[] = [
    { key: "customerName", label: "Customer" },
    { key: "claimedByName", label: "Dilaporkan oleh" },
    { key: "method", label: "Metode", render: (row) => METHOD_LABELS[row.method] ?? row.method },
    { key: "amount", label: "Nominal", align: "right", render: (row) => formatRupiah(row.amount) },
    {
      key: "claimedAt",
      label: "Dilaporkan",
      render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.claimedAt)}</span>,
    },
    { key: "note", label: "Catatan", render: (row) => <span className="text-xs text-gray-500">{row.note ?? "-"}</span> },
  ];

  const pendingColumns: Column<PaymentClaimListItem>[] = [
    ...baseColumns,
    {
      key: "id",
      label: "Aksi",
      render: (row) => (canDecide ? <PaymentClaimReviewPanel claim={row} outstandingInvoices={outstandingInvoices} /> : <span className="text-xs text-gray-400">-</span>),
    },
  ];

  const decidedColumns: Column<PaymentClaimListItem>[] = [
    ...baseColumns,
    { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} domain="payment_claim" /> },
    {
      key: "reviewedByName",
      label: "Diputuskan oleh",
      render: (row) => (
        <span className="text-xs text-gray-600">
          {row.reviewedByName ?? "-"}
          {row.reviewedAt ? ` · ${formatJakartaDateTime(row.reviewedAt)}` : ""}
        </span>
      ),
    },
    {
      key: "rejectionReason",
      label: "Keterangan",
      render: (row) => <span className="text-xs text-gray-500">{row.rejectionReason ?? "-"}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Klaim Pembayaran"
        subtitle="Laporan pembayaran dari sales/driver yang menerima cash/transfer langsung dari customer -- menunggu review sebelum masuk ke pembukuan resmi."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar klaim</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900">Menunggu Review ({pending.length})</h2>
            {pending.length === 0 ? (
              <EmptyState title="Tidak ada klaim menunggu review" description="Klaim baru dari sales/driver akan muncul di sini." />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <DataTable<PaymentClaimListItem> columns={pendingColumns} data={pending} keyExtractor={(row) => row.id} />
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900">Riwayat Keputusan</h2>
            {decided.length === 0 ? (
              <p className="text-xs text-gray-400">Belum ada klaim yang diputuskan.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <DataTable<PaymentClaimListItem> columns={decidedColumns} data={decided} keyExtractor={(row) => row.id} />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
