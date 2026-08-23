// =============================================================================
// Owner Unlock Inbox -- daftar pengajuan buka-kunci toko tertunggak yang
// menunggu keputusan Owner. Menggunakan RPC Gate P4.16-B: submit_store_
// unlock_request_atomic / decide_store_unlock_request_atomic. Tidak ada RPC/
// tabel baru di sini -- pola identik dashboard/orders/approvals/page.tsx.
//
// Akses murni role='owner' (bukan permission table) -- identik pengecekan
// strict di dalam RPC decide_store_unlock_request_atomic sendiri.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import {
  getPendingStoreUnlockRequests,
  type PendingStoreUnlockRequestItem,
} from "@/lib/customers/unlock-request-actions";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { UnlockRequestReviewPanel } from "@/components/customers/unlock-request-review-panel";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Buka Kunci Toko — AODP" };

export default async function StoreUnlockRequestsPage() {
  const user = await getAuthUser();

  if (!hasRole(user.roles, "owner")) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Buka Kunci Toko membaca dan mengubah data pelanggan nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  let requests: PendingStoreUnlockRequestItem[] = [];
  let loadError = false;
  try {
    requests = await getPendingStoreUnlockRequests(user.company_id);
  } catch {
    loadError = true;
  }

  const columns: Column<PendingStoreUnlockRequestItem>[] = [
    { key: "customerName", label: "Toko" },
    { key: "requestedByName", label: "Diajukan oleh" },
    { key: "reason", label: "Alasan", render: (row) => <span className="text-xs text-gray-500">{row.reason ?? "-"}</span> },
    {
      key: "requestedAt",
      label: "Diajukan",
      render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.requestedAt)}</span>,
    },
    {
      key: "requestId",
      label: "Aksi",
      render: (row) => <UnlockRequestReviewPanel request={row} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buka Kunci Toko"
        subtitle="Toko dengan tagihan tertunggak >= H+3 terkunci dari order baru. Sales mengajukan buka kunci di sini -- setujui memberi izin sekali pakai untuk satu order berikutnya."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar pengajuan</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : requests.length === 0 ? (
        <EmptyState title="Tidak ada pengajuan menunggu" description="Pengajuan buka kunci toko baru dari Sales akan muncul di sini." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <DataTable<PendingStoreUnlockRequestItem> columns={columns} data={requests} keyExtractor={(row) => row.requestId} />
        </div>
      )}
    </div>
  );
}
