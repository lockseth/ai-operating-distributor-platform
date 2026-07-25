// =============================================================================
// Gate 2I.3 -- Customer Credit & Refund: list (kontrak §5.6/§8). Dua bagian:
// (1) pengajuan refund (status requested diprioritaskan), (2) saldo customer
// credit per credit note (customer_credit_amount > 0 saja -- credit note yang
// habis terpakai ke piutang tidak relevan di sini). "Ajukan Refund" dirender
// PER BARIS credit note (credit_note_id sudah tetap dari konteks baris, bukan
// picker yang bisa mengagregasi -- kontrak §8 larangan tegas).
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getCreditNoteList,
  getRefundList,
  hasFinanceWorkspaceAccess,
  type CreditNoteListItem,
  type RefundListItem,
} from "@/lib/finance/queries";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { RequestRefundPanel } from "@/components/finance/refund-panels";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Customer Credit & Refund — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

// Label eksplisit untuk saldo yang belum diinisialisasi (isInitialized=false) --
// TIDAK dirender sebagai "Rp0" seolah saldo sudah habis. "Rp0" tetap dipakai apa
// adanya untuk canonical zero (isInitialized=true, saldo memang habis terpakai).
function BalanceCell({ amount, isInitialized }: { amount: number; isInitialized: boolean }) {
  if (!isInitialized) {
    return (
      <span title="Belum ada baris customer_credit_ledger untuk credit note ini" className="text-gray-400">
        Belum diinisialisasi
      </span>
    );
  }
  return <>{formatRupiah(amount)}</>;
}

function RefundCard({ item }: { item: RefundListItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/dashboard/finance/credit/${item.id}`} className="font-mono text-sm font-semibold text-blue-600 hover:underline">
            {item.invoiceNumber}
          </Link>
          <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
        </div>
        <StatusBadge status={item.status} domain="refund" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Nominal</dt>
          <dd className="font-semibold text-gray-900">{formatRupiah(item.amount)}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Metode</dt>
          <dd className="text-gray-700">{METHOD_LABELS[item.method] ?? item.method}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-gray-400">Diajukan</dt>
          <dd className="text-gray-700">{formatJakartaDateTime(item.requestedAt)}</dd>
        </div>
      </dl>
    </li>
  );
}

function CreditNoteCard({ item, canRequestRefund }: { item: CreditNoteListItem; canRequestRefund: boolean }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-gray-800">{item.invoiceNumber}</p>
          <p className="mt-0.5 text-xs text-gray-500">{item.customerName}</p>
        </div>
        {item.isReversed ? (
          <span className="text-xs text-gray-500">Sudah Direverse</span>
        ) : (
          <span className="text-xs font-medium text-green-600">Aktif</span>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="col-span-2">
          <dt className="text-gray-400">Nilai Credit Awal</dt>
          <dd className="text-gray-700">{formatRupiah(item.customerCreditAmount)}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Saldo Ledger</dt>
          <dd className="text-gray-700">
            <BalanceCell amount={item.ledgerBalance} isInitialized={item.isInitialized} />
          </dd>
        </div>
        <div>
          <dt className="text-gray-400">Direservasi Pending</dt>
          <dd className="text-gray-700">
            <BalanceCell amount={item.pendingReserved} isInitialized={item.isInitialized} />
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-gray-400">Saldo Tersedia</dt>
          <dd className="font-semibold text-gray-900">
            <BalanceCell amount={item.availableBalance} isInitialized={item.isInitialized} />
          </dd>
        </div>
      </dl>
      {!item.isReversed && (
        <div className="mt-3">
          <RequestRefundPanel
            creditNoteId={item.id}
            customerCreditAmount={item.customerCreditAmount}
            isInitialized={item.isInitialized}
            availableBalance={item.availableBalance}
            canRequest={canRequestRefund}
          />
        </div>
      )}
    </li>
  );
}

export default async function CreditWorkspacePage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Customer Credit & Refund membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const canRequestRefund = hasPermission(user.permissions, "refund.request");

  let refunds: RefundListItem[] = [];
  let creditNotes: CreditNoteListItem[] = [];
  let loadError = false;
  try {
    [refunds, creditNotes] = await Promise.all([getRefundList(user.company_id), getCreditNoteList(user.company_id)]);
  } catch {
    loadError = true;
  }

  const refundColumns: Column<RefundListItem>[] = [
    {
      key: "invoiceNumber",
      label: "Invoice",
      render: (row) => (
        <Link href={`/dashboard/finance/credit/${row.id}`} className="font-mono text-xs font-semibold text-blue-600 hover:underline">
          {row.invoiceNumber}
        </Link>
      ),
    },
    { key: "customerName", label: "Customer" },
    { key: "amount", label: "Nominal", align: "right", render: (row) => formatRupiah(row.amount) },
    { key: "method", label: "Metode", render: (row) => METHOD_LABELS[row.method] ?? row.method },
    { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} domain="refund" /> },
    {
      key: "requestedAt",
      label: "Diajukan",
      render: (row) => <span className="text-xs text-gray-600">{formatJakartaDateTime(row.requestedAt)}</span>,
    },
  ];

  const creditNoteColumns: Column<CreditNoteListItem>[] = [
    { key: "invoiceNumber", label: "Invoice Asal" },
    { key: "customerName", label: "Customer" },
    {
      key: "customerCreditAmount",
      label: "Nilai Credit Awal",
      align: "right",
      render: (row) => formatRupiah(row.customerCreditAmount),
    },
    {
      key: "ledgerBalance",
      label: "Saldo Ledger",
      align: "right",
      render: (row) => <BalanceCell amount={row.ledgerBalance} isInitialized={row.isInitialized} />,
    },
    {
      key: "pendingReserved",
      label: "Direservasi Pending",
      align: "right",
      render: (row) => <BalanceCell amount={row.pendingReserved} isInitialized={row.isInitialized} />,
    },
    {
      key: "availableBalance",
      label: "Saldo Tersedia",
      align: "right",
      render: (row) => (
        <span className="font-semibold text-gray-900">
          <BalanceCell amount={row.availableBalance} isInitialized={row.isInitialized} />
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (row) =>
        row.isReversed ? <span className="text-xs text-gray-500">Sudah Direverse</span> : <span className="text-xs text-green-600">Aktif</span>,
    },
    {
      key: "action",
      label: "Aksi",
      align: "center",
      render: (row) =>
        row.isReversed ? (
          <span className="text-xs text-gray-400">—</span>
        ) : (
          <RequestRefundPanel
            creditNoteId={row.id}
            customerCreditAmount={row.customerCreditAmount}
            isInitialized={row.isInitialized}
            availableBalance={row.availableBalance}
            canRequest={canRequestRefund}
          />
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer Credit & Refund"
        subtitle="Saldo customer credit dari retur yang disetujui, beserta pengajuan dan keputusan refund."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat data customer credit &amp; refund</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : (
        <>
          <div>
            <SectionHeader title="Pengajuan Refund" />
            {refunds.length === 0 ? (
              <EmptyState title="Belum ada pengajuan refund" description="Refund diajukan dari daftar saldo customer credit di bawah." />
            ) : (
              <>
                <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
                  <DataTable<RefundListItem> columns={refundColumns} data={refunds} keyExtractor={(row) => row.id} />
                </div>
                <ul className="space-y-2 md:hidden">
                  {refunds.map((item) => (
                    <RefundCard key={item.id} item={item} />
                  ))}
                </ul>
              </>
            )}
          </div>

          <div>
            <SectionHeader
              title="Saldo Customer Credit"
              description="Diturunkan dari retur yang menghasilkan customer credit (customer_credit_amount > 0)."
            />
            {creditNotes.length === 0 ? (
              <EmptyState title="Belum ada saldo customer credit" description="Saldo muncul setelah retur dengan sisa customer credit disetujui." />
            ) : (
              <>
                <div className="hidden rounded-xl border border-gray-200 bg-white md:block">
                  <DataTable<CreditNoteListItem> columns={creditNoteColumns} data={creditNotes} keyExtractor={(row) => row.id} />
                </div>
                <ul className="space-y-2 md:hidden">
                  {creditNotes.map((item) => (
                    <CreditNoteCard key={item.id} item={item} canRequestRefund={canRequestRefund} />
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
