// =============================================================================
// Gate 2I.3 -- Retur & Credit Note: list (kontrak §5.5). READ-ONLY -- mutation
// "Ajukan Retur" ada di halaman detail invoice (invoice.lines sudah tersedia
// di sana), "Verifikasi Retur" (Owner-only) ada di halaman detail retur [id].
// Status requested diprioritaskan (kontrak §3 tabel item #5).
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getReturnList, hasFinanceWorkspaceAccess, type ReturnListItem } from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Retur & Credit Note — AODP" };

const columns: Column<ReturnListItem>[] = [
  {
    key: "invoiceNumber",
    label: "Invoice",
    render: (row) => (
      <Link href={`/dashboard/finance/returns/${row.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">
        {row.invoiceNumber}
      </Link>
    ),
  },
  { key: "customerName", label: "Customer" },
  { key: "reasonCode", label: "Alasan" },
  {
    key: "requestedAt",
    label: "Diajukan",
    render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.requestedAt)}</span>,
  },
  {
    key: "status",
    label: "Status",
    render: (row) => <StatusBadge status={row.status} domain="return" />,
  },
  {
    key: "creditNoteTotalAmount",
    label: "Nilai Credit Note",
    align: "right",
    render: (row) => (row.creditNoteTotalAmount != null ? formatRupiah(row.creditNoteTotalAmount) : "—"),
  },
];

function ReturnCard({ item }: { item: ReturnListItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/dashboard/finance/returns/${item.id}`} className="font-mono text-sm font-semibold text-blue-600 hover:underline">
            {item.invoiceNumber}
          </Link>
          <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
        </div>
        <StatusBadge status={item.status} domain="return" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Alasan</dt>
          <dd className="text-gray-700">{item.reasonCode}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Diajukan</dt>
          <dd className="text-gray-700">{formatJakartaDateTime(item.requestedAt)}</dd>
        </div>
        {item.creditNoteTotalAmount != null && (
          <div className="col-span-2">
            <dt className="text-gray-400">Nilai Credit Note</dt>
            <dd className="font-semibold text-gray-900">{formatRupiah(item.creditNoteTotalAmount)}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

export default async function ReturnListPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Retur & Credit Note membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  let items: ReturnListItem[] = [];
  let loadError = false;
  try {
    items = await getReturnList(user.company_id);
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Retur & Credit Note"
        subtitle="Retur yang diajukan terhadap invoice beserta hasil verifikasinya. Ajukan retur baru dari halaman detail invoice."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat daftar retur</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Belum ada retur"
          description="Retur akan muncul di sini setelah diajukan dari halaman detail invoice."
        />
      ) : (
        <>
          <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
            <DataTable<ReturnListItem> columns={columns} data={items} keyExtractor={(row) => row.id} />
          </div>
          <ul className="space-y-2 md:hidden">
            {items.map((item) => (
              <ReturnCard key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
