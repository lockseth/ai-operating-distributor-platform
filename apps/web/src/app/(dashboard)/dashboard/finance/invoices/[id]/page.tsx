// =============================================================================
// Gate 2I.2 -- Invoice & Piutang: detail (kontrak §5.1/§6). READ-ONLY penuh.
// Cross-tenant (FIN-03-01): getInvoiceDetail() scoped company_id + RLS --
// invoice milik company lain selalu null di sini -> notFound(), bukan data
// company lain yang bocor.
//
// Gate 2I.3 -- section "Retur & Credit Note" ditambahkan di bawah (kontrak §6
// "link ke return/credit note terkait"): invoice.lines yang sudah dimuat di
// atas dipakai langsung oleh RequestReturnPanel, tanpa query invoice-picker
// terpisah. Ini murni PENAMBAHAN -- struktur/behavior existing di atas tidak
// diubah.
//
// Gate 2I.4 -- section "Pembatalan Order" ditambahkan (kontrak §B.4):
// RequestCancellationPanel terikat invoice.salesOrderId yang sudah dimuat di
// atas (BUKAN picker banyak order), plus link ke cancellation terkait bila
// ada (kontrak CXL-11/CXL-12).
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getCancellationForOrder,
  getInvoiceDetail,
  getOrderCancellationEligibility,
  getReturnsForInvoice,
  hasFinanceWorkspaceAccess,
} from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { RequestReturnPanel } from "@/components/finance/return-panels";
import { RequestCancellationPanel } from "@/components/finance/cancellation-panels";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import type { InvoiceDetailLine, InvoiceLedgerEntry, ReturnListItem } from "@/lib/finance/queries";

export const metadata = { title: "Detail Invoice — AODP" };

const LEDGER_ENTRY_LABELS: Record<string, string> = {
  invoice_issued: "Invoice Diterbitkan",
  payment_allocation: "Alokasi Pembayaran",
  credit_note: "Credit Note",
  credit_note_reversal: "Reverse Credit Note",
  invoice_void: "Invoice Void",
};

const lineColumns: Column<InvoiceDetailLine>[] = [
  { key: "lineNo", label: "#" },
  { key: "productName", label: "Produk" },
  { key: "unit", label: "Satuan", render: (row) => row.unit ?? "—" },
  { key: "quantity", label: "Qty", align: "right", render: (row) => row.quantity.toLocaleString("id-ID") },
  { key: "unitPrice", label: "Harga Satuan", align: "right", render: (row) => formatRupiah(row.unitPrice) },
  { key: "discountAmount", label: "Diskon", align: "right", render: (row) => formatRupiah(row.discountAmount) },
  { key: "lineTotal", label: "Total", align: "right", render: (row) => <span className="font-medium">{formatRupiah(row.lineTotal)}</span> },
];

const ledgerColumns: Column<InvoiceLedgerEntry>[] = [
  { key: "createdAt", label: "Waktu", render: (row) => formatJakartaDateTime(row.createdAt) },
  { key: "entryType", label: "Jenis", render: (row) => LEDGER_ENTRY_LABELS[row.entryType] ?? row.entryType },
  {
    key: "direction",
    label: "Arah",
    render: (row) => (
      <span className={row.direction === "debit" ? "text-amber-700" : "text-green-700"}>
        {row.direction === "debit" ? "Debit (+)" : "Kredit (−)"}
      </span>
    ),
  },
  { key: "amount", label: "Nominal", align: "right", render: (row) => formatRupiah(row.amount) },
];

function StatCard({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-1 text-sm ${emphasis ? "font-bold text-gray-900" : "font-semibold text-gray-700"}`}>{value}</p>
    </div>
  );
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Detail invoice membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const invoice = await getInvoiceDetail(user.company_id, id);
  if (!invoice) notFound();

  let returns: ReturnListItem[] = [];
  let returnsLoadError = false;
  try {
    returns = await getReturnsForInvoice(user.company_id, id);
  } catch {
    returnsLoadError = true;
  }
  const canRequestReturn = hasPermission(user.permissions, "return.request");

  let relatedCancellation: Awaited<ReturnType<typeof getCancellationForOrder>> = null;
  let eligibleBlockedReason: string | null = null;
  let cancellationLoadError = false;
  try {
    [relatedCancellation, { blockedReason: eligibleBlockedReason }] = await Promise.all([
      getCancellationForOrder(user.company_id, invoice.salesOrderId),
      getOrderCancellationEligibility(user.company_id, invoice.salesOrderId),
    ]);
  } catch {
    cancellationLoadError = true;
  }
  const canRequestCancellation = hasPermission(user.permissions, "order_cancellation.request");

  return (
    <div className="space-y-5">
      <PageHeader
        title={invoice.invoiceNumber}
        subtitle={invoice.customerName}
      >
        <StatusBadge status={invoice.financialStatus} domain="invoice" />
        {invoice.promiseStatus && <StatusBadge status={invoice.promiseStatus} domain="promise" />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Nilai Invoice" value={formatRupiah(invoice.totalAmount)} />
        <StatCard label="Total Terbayar" value={formatRupiah(invoice.totalPaid)} />
        <StatCard label="Pengurangan Credit Note" value={formatRupiah(invoice.creditNoteReduction)} />
        <StatCard label="Outstanding" value={formatRupiah(invoice.outstandingBalance)} emphasis />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-gray-400">Tanggal Terbit</dt>
            <dd className="mt-0.5 text-gray-700">{formatJakartaDateTime(invoice.issuedAt)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">Jatuh Tempo</dt>
            <dd className="mt-0.5 text-gray-700">{invoice.dueDate ? formatJakartaDateTime(invoice.dueDate) : "—"}</dd>
          </div>
          <div>
            <dt className="text-gray-400">Order Asal</dt>
            <dd className="mt-0.5">
              <Link href={`/dashboard/orders/${invoice.salesOrderId}`} className="font-mono text-blue-600 hover:underline">
                {invoice.salesOrderNumber}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-gray-400">Pembayaran Terkait</dt>
            <dd className="mt-0.5">
              {invoice.paymentReceiptIds.length === 0 ? (
                <span className="text-gray-400">—</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {invoice.paymentReceiptIds.map((receiptId) => (
                    <Link
                      key={receiptId}
                      href={`/dashboard/finance/payments/${receiptId}`}
                      className="font-mono text-blue-600 hover:underline"
                    >
                      {receiptId.slice(0, 8)}…
                    </Link>
                  ))}
                </div>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <SectionHeader title="Rincian Item" />
        <div className="rounded-xl border border-gray-200 bg-white">
          <DataTable<InvoiceDetailLine> columns={lineColumns} data={invoice.lines} keyExtractor={(row) => row.id} compact />
        </div>
      </div>

      <div>
        <SectionHeader title="Riwayat Ledger Piutang" description="Buku besar piutang append-only untuk invoice ini." />
        <div className="rounded-xl border border-gray-200 bg-white">
          <DataTable<InvoiceLedgerEntry> columns={ledgerColumns} data={invoice.ledger} keyExtractor={(row) => row.id} compact />
        </div>
      </div>

      <div>
        <SectionHeader title="Retur & Credit Note" description="Retur yang diajukan terhadap invoice ini." />
        <div className="mb-3">
          <RequestReturnPanel invoiceId={invoice.id} lines={invoice.lines} canRequest={canRequestReturn} />
        </div>
        {returnsLoadError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-xs text-red-600">
            Gagal memuat retur untuk invoice ini.
          </div>
        ) : returns.length === 0 ? (
          <p className="text-xs text-gray-400">Belum ada retur untuk invoice ini.</p>
        ) : (
          <ul className="space-y-2">
            {returns.map((ret) => (
              <li key={ret.id} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3.5">
                <div>
                  <Link href={`/dashboard/finance/returns/${ret.id}`} className="text-xs font-semibold text-blue-600 hover:underline">
                    {ret.reasonCode}
                  </Link>
                  <p className="mt-0.5 text-xs text-gray-400">{formatJakartaDateTime(ret.requestedAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {ret.creditNoteTotalAmount != null && (
                    <span className="text-xs font-medium text-gray-700">{formatRupiah(ret.creditNoteTotalAmount)}</span>
                  )}
                  <StatusBadge status={ret.status} domain="return" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <SectionHeader title="Pembatalan Order" description="Mengajukan pembatalan akan menunggu keputusan Owner. Order dan invoice tidak berubah sampai disetujui." />
        <div className="mb-3">
          <RequestCancellationPanel
            salesOrderId={invoice.salesOrderId}
            invoiceId={invoice.id}
            canRequest={canRequestCancellation}
            eligibleBlockedReason={eligibleBlockedReason}
          />
        </div>
        {cancellationLoadError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-xs text-red-600">
            Gagal memuat data pembatalan untuk order ini.
          </div>
        ) : relatedCancellation ? (
          <Link
            href={`/dashboard/finance/cancellations/${relatedCancellation.id}`}
            className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3.5"
          >
            <span className="text-xs font-semibold text-blue-600 hover:underline">Lihat pengajuan pembatalan order ini</span>
            <StatusBadge status={relatedCancellation.status} domain="cancellation" />
          </Link>
        ) : (
          <p className="text-xs text-gray-400">Belum ada pengajuan pembatalan untuk order ini.</p>
        )}
      </div>
    </div>
  );
}
