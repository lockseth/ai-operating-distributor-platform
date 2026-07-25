// =============================================================================
// Gate 2I.2 -- Invoice & Piutang: detail (kontrak §5.1/§6). READ-ONLY penuh.
// Cross-tenant (FIN-03-01): getInvoiceDetail() scoped company_id + RLS --
// invoice milik company lain selalu null di sini -> notFound(), bukan data
// company lain yang bocor.
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getInvoiceDetail, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";
import type { InvoiceDetailLine, InvoiceLedgerEntry } from "@/lib/finance/queries";

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
    </div>
  );
}
