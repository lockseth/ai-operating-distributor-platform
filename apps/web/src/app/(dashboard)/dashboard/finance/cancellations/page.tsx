// =============================================================================
// Gate 2I.4 -- Cancellation & Invoice Void: list (kontrak §B.2). READ-ONLY --
// mutation "Ajukan Pembatalan" ada di halaman detail invoice, "Keputusan"
// (Owner-only) ada di halaman detail cancellation [id]. Menampilkan SEMUA
// status (bukan hanya requested seperti action queue) -- status requested
// diprioritaskan (kontrak §B.2, CANCELLATION_LIST_STATUS_PRIORITY).
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getCancellationList, hasFinanceWorkspaceAccess, type CancellationListItem } from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Cancellation & Invoice Void — AODP" };

const columns: Column<CancellationListItem>[] = [
  {
    key: "orderNumber",
    label: "Order",
    render: (row) => (
      <Link
        href={`/dashboard/finance/cancellations/${row.id}`}
        className="font-mono text-xs font-semibold text-blue-600 hover:underline"
      >
        {row.orderNumber}
      </Link>
    ),
  },
  { key: "customerName", label: "Customer" },
  { key: "reasonCode", label: "Alasan" },
  {
    key: "requestedAt",
    label: "Diajukan",
    render: (row) => (
      <div>
        <p className="text-xs text-gray-700">{row.requestedByName}</p>
        <p className="text-xs text-gray-400">{formatJakartaDateTime(row.requestedAt)}</p>
      </div>
    ),
  },
  {
    key: "decidedAt",
    label: "Diputuskan",
    render: (row) =>
      row.decidedAt ? (
        <div>
          <p className="text-xs text-gray-700">{row.decidedByName}</p>
          <p className="text-xs text-gray-400">{formatJakartaDateTime(row.decidedAt)}</p>
        </div>
      ) : (
        <span className="text-xs text-gray-300">—</span>
      ),
  },
  {
    key: "status",
    label: "Status",
    render: (row) => <StatusBadge status={row.status} domain="cancellation" />,
  },
];

function CancellationCard({ item }: { item: CancellationListItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/dashboard/finance/cancellations/${item.id}`}
            className="font-mono text-sm font-semibold text-blue-600 hover:underline"
          >
            {item.orderNumber}
          </Link>
          <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
        </div>
        <StatusBadge status={item.status} domain="cancellation" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Alasan</dt>
          <dd className="text-gray-700">{item.reasonCode}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Diajukan</dt>
          <dd className="text-gray-700">
            {item.requestedByName} · {formatJakartaDateTime(item.requestedAt)}
          </dd>
        </div>
        {item.decidedAt && (
          <div className="col-span-2">
            <dt className="text-gray-400">Diputuskan</dt>
            <dd className="text-gray-700">
              {item.decidedByName} · {formatJakartaDateTime(item.decidedAt)}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

export default async function CancellationListPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Cancellation & Invoice Void membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  let items: CancellationListItem[] = [];
  let loadError = false;
  try {
    items = await getCancellationList(user.company_id);
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cancellation & Invoice Void"
        subtitle="Pengajuan pembatalan order beserta keputusan Owner. Ajukan pembatalan baru dari halaman detail invoice."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar cancellation</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Belum ada pengajuan pembatalan"
          description="Pengajuan pembatalan akan muncul di sini setelah diajukan dari halaman detail invoice."
        />
      ) : (
        <>
          <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
            <DataTable<CancellationListItem> columns={columns} data={items} keyExtractor={(row) => row.id} />
          </div>
          <ul className="space-y-2 md:hidden">
            {items.map((item) => (
              <CancellationCard key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
