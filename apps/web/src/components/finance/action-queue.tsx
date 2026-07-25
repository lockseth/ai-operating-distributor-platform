// =============================================================================
// Gate 2I.1 -- Antrean "Perlu Tindakan" Finance Operations, READ-ONLY.
//
// Tidak ada tombol mutation/RPC di sini sama sekali (kontrak §3/§4 catatan 1)
// -- "Lihat" selalu disabled karena detail per-domain (invoices/[id],
// returns/[id], dst) belum ada pada Gate 2I.1 (lihat layout.tsx: seluruh
// tab selain Ringkasan masih non-aktif). Ini SENGAJA bukan tautan ke route
// yang belum ada (instruksi gate: "jangan membuat tautan yang berakhir 404").
// Card-list mobile digabung dalam file yang sama (bukan component generic
// terpisah) untuk menjaga batas 10 file Gate 2I.1 -- struktur tetap generic
// (bukan per-domain) sehingga aman diekstrak terpisah di gate lanjutan tanpa
// mengubah perilaku.
// =============================================================================

import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import {
  FINANCE_ACTION_CATEGORY_META,
  type FinanceActionCategory,
  type FinanceActionQueueItem,
} from "@/lib/finance/queries";

interface ActionQueueSectionProps {
  items: FinanceActionQueueItem[];
  failedCategories: FinanceActionCategory[];
  loadError: boolean;
}

function DetailAffordance() {
  return (
    <button
      type="button"
      disabled
      aria-label="Lihat detail — tersedia pada tahap implementasi berikutnya"
      title="Detail tersedia pada tahap implementasi berikutnya"
      className="inline-flex cursor-not-allowed items-center rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-300"
    >
      Lihat
    </button>
  );
}

function OwnerOnlyMarker() {
  return (
    <span className="mt-1 inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700">
      Owner diperlukan
    </span>
  );
}

const columns: Column<FinanceActionQueueItem>[] = [
  {
    key: "categoryLabel",
    label: "Jenis Tindakan",
    render: (row) => (
      <div>
        <p className="font-medium text-gray-900">{row.categoryLabel}</p>
        {row.ownerOnly && <OwnerOnlyMarker />}
      </div>
    ),
  },
  {
    key: "entityLabel",
    label: "Customer/Outlet",
  },
  {
    key: "referenceNumber",
    label: "Referensi",
    render: (row) => <span className="font-mono text-xs text-gray-600">{row.referenceNumber}</span>,
  },
  {
    key: "amount",
    label: "Nominal",
    align: "right",
    render: (row) => (row.amount != null ? formatRupiah(row.amount) : "—"),
  },
  {
    key: "statusCode",
    label: "Status",
    render: (row) => <StatusBadge status={row.statusCode} domain={row.statusDomain} />,
  },
  {
    key: "eventDate",
    label: "Jatuh Tempo/Waktu",
    align: "right",
    render: (row) => (
      <div>
        <p className="text-xs text-gray-700">{formatJakartaDateTime(row.eventDate)}</p>
        {row.ageDays != null && <p className="text-xs text-gray-400">{row.ageDays} hari</p>}
      </div>
    ),
  },
  {
    key: "roleNote",
    label: "Role",
    render: (row) => <span className="text-xs text-gray-500">{row.roleNote}</span>,
  },
  {
    key: "detail",
    label: "Detail",
    align: "center",
    render: () => <DetailAffordance />,
  },
];

function ActionQueueCard({ item }: { item: FinanceActionQueueItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{item.categoryLabel}</p>
          <p className="mt-0.5 text-xs text-gray-500">{item.entityLabel}</p>
          <p className="mt-0.5 font-mono text-xs text-gray-400">{item.referenceNumber}</p>
        </div>
        <StatusBadge status={item.statusCode} domain={item.statusDomain} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Nominal</dt>
          <dd className="font-medium text-gray-800">{item.amount != null ? formatRupiah(item.amount) : "—"}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Jatuh Tempo/Waktu</dt>
          <dd className="text-gray-700">
            {formatJakartaDateTime(item.eventDate)}
            {item.ageDays != null && <span className="text-gray-400"> · {item.ageDays} hari</span>}
          </dd>
        </div>
        <div>
          <dt className="text-gray-400">Role</dt>
          <dd className="text-gray-700">{item.roleNote}</dd>
        </div>
      </dl>

      <div className="mt-3 flex items-center justify-between">
        {item.ownerOnly ? <OwnerOnlyMarker /> : <span />}
        <DetailAffordance />
      </div>
    </li>
  );
}

export function ActionQueueSection({ items, failedCategories, loadError }: ActionQueueSectionProps) {
  if (loadError) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-sm font-semibold text-red-700">Gagal memuat antrean tindakan</p>
        <p className="mt-1 text-xs text-red-500">
          Terjadi kendala saat mengambil data dari server. Coba muat ulang halaman.
        </p>
        <a
          href="/dashboard/finance"
          className="mt-3 inline-block rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
        >
          Muat Ulang
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {failedCategories.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
          Sebagian data gagal dimuat: {failedCategories.map((c) => FINANCE_ACTION_CATEGORY_META[c].label).join(", ")}.
          {" "}
          <a href="/dashboard/finance" className="font-semibold underline">
            Muat ulang
          </a>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Tidak ada tindakan yang perlu diperhatikan"
          description="Semua invoice, janji bayar, dan pengajuan finance dalam kondisi aman saat ini."
        />
      ) : (
        <>
          <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
            <DataTable<FinanceActionQueueItem> columns={columns} data={items} keyExtractor={(row) => row.id} />
          </div>
          <ul className="space-y-2 md:hidden">
            {items.map((item) => (
              <ActionQueueCard key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
