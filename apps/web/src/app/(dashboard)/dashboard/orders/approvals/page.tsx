// =============================================================================
// Owner Approval Inbox -- daftar permintaan harga khusus (special price
// proposal) yang menunggu keputusan Owner. Menggunakan RPC existing LOCKED
// (Gate 3E-D4-C2/C3): submit_special_price_proposal_atomic /
// decide_special_price_proposal_atomic. Tidak ada RPC/tabel baru.
//
// Akses murni role='owner' (bukan permission table) -- identik pengecekan
// strict di dalam RPC decide_special_price_proposal_atomic sendiri.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import {
  getPendingSpecialPriceProposals,
  type PendingSpecialPriceProposalItem,
} from "@/lib/orders/special-price-proposal-actions";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { SpecialPriceApprovalReviewPanel } from "@/components/orders/special-price-approval-review-panel";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Persetujuan Harga Khusus — AODP" };

export default async function SpecialPriceApprovalsPage() {
  const user = await getAuthUser();

  if (!hasRole(user.roles, "owner")) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Persetujuan Harga Khusus membaca dan mengubah data order nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  let proposals: PendingSpecialPriceProposalItem[] = [];
  let loadError = false;
  try {
    proposals = await getPendingSpecialPriceProposals(user.company_id);
  } catch {
    loadError = true;
  }

  const columns: Column<PendingSpecialPriceProposalItem>[] = [
    { key: "orderNumber", label: "Order", render: (row) => <span className="font-mono text-xs">{row.orderNumber}</span> },
    { key: "customerName", label: "Customer" },
    { key: "requestedByName", label: "Diajukan oleh" },
    {
      key: "lines",
      label: "Item & Diskon",
      render: (row) => (
        <div className="space-y-0.5">
          {row.lines.map((line, idx) => (
            <p key={idx} className="text-xs text-gray-600">
              {line.productName} · {formatRupiah(line.proposedUnitPrice)}{" "}
              <span className="text-amber-600">(-{line.impliedDiscountPercentage.toFixed(1)}%)</span>
            </p>
          ))}
        </div>
      ),
    },
    { key: "reason", label: "Alasan", render: (row) => <span className="text-xs text-gray-500">{row.reason ?? "-"}</span> },
    {
      key: "requestedAt",
      label: "Diajukan",
      render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.requestedAt)}</span>,
    },
    {
      key: "approvalRequestId",
      label: "Aksi",
      render: (row) => <SpecialPriceApprovalReviewPanel proposal={row} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Persetujuan Harga Khusus"
        subtitle="Permintaan harga di luar kebijakan diskon standar yang diajukan Sales -- order tertahan sampai Anda menyetujui atau menolak."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar permintaan</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : proposals.length === 0 ? (
        <EmptyState title="Tidak ada permintaan menunggu" description="Permintaan harga khusus baru dari Sales akan muncul di sini." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <DataTable<PendingSpecialPriceProposalItem> columns={columns} data={proposals} keyExtractor={(row) => row.approvalRequestId} />
        </div>
      )}
    </div>
  );
}
