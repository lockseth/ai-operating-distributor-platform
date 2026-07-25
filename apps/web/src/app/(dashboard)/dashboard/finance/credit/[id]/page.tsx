// =============================================================================
// Gate 2I.3 -- Customer Credit & Refund: detail (kontrak §5.6/§7.3/§7.4).
// [id] adalah refund_id (konsisten dengan deep link action queue §3 tabel
// item #6 "/dashboard/finance/credit/[refund_id]"). Saldo SELALU dibaca dari
// view customer_credit_balances -- tidak pernah dihitung ulang di sini
// (kontrak §8 "jangan membuat formula saldo alternatif di frontend").
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getRefundDetail, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { ApproveRefundPanel } from "@/components/finance/refund-panels";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Detail Refund — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

export default async function RefundDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
        message="Detail refund membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const refund = await getRefundDetail(user.company_id, id);
  if (!refund) notFound();

  const canApprove = hasPermission(user.permissions, "refund.approve");

  return (
    <div className="space-y-5">
      <PageHeader title={`Refund — ${refund.invoiceNumber}`} subtitle={refund.customerName}>
        {refund.status === "requested" && <ApproveRefundPanel refundId={refund.id} canApprove={canApprove} />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Status</p>
          <p className="mt-1">
            <StatusBadge status={refund.status} domain="refund" />
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Nominal</p>
          <p className="mt-1 text-sm font-bold text-gray-900">{formatRupiah(refund.amount)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Metode</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{METHOD_LABELS[refund.method] ?? refund.method}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Tanggal Transaksi</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{formatJakartaDateTime(refund.transactionDate)}</p>
        </div>
      </div>

      {refund.status === "rejected" && (
        <AlertCard
          type="info"
          title="Ditolak — Saldo customer credit tidak berubah"
          message="Refund ini ditolak. Reservasi saldo dilepaskan, tidak ada efek ledger apa pun."
        />
      )}

      <div>
        <SectionHeader title="Detail Pengajuan" />
        <div className="space-y-1 rounded-xl border border-gray-200 bg-white p-4 text-xs">
          <p>
            <span className="text-gray-400">Referensi Bukti:</span> <span className="text-gray-700">{refund.proofReference}</span>
          </p>
          <p>
            <span className="text-gray-400">Diajukan Oleh:</span> <span className="text-gray-700">{refund.requestedByName}</span> ·{" "}
            {formatJakartaDateTime(refund.requestedAt)}
          </p>
          {refund.decidedByName && (
            <p>
              <span className="text-gray-400">Diputuskan Oleh:</span> <span className="text-gray-700">{refund.decidedByName}</span>{" "}
              {refund.decidedAt && <>· {formatJakartaDateTime(refund.decidedAt)}</>}
            </p>
          )}
          <p>
            <span className="text-gray-400">Invoice Asal:</span>{" "}
            <Link href={`/dashboard/finance/invoices/${refund.invoiceId}`} className="font-mono text-blue-600 hover:underline">
              {refund.invoiceNumber}
            </Link>
          </p>
        </div>
      </div>

      <div>
        <SectionHeader
          title="Saldo Credit Note Sumber"
          description="Satu refund hanya mengacu pada satu bucket credit note (refund_requests.credit_note_id tunggal), tidak digabung."
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Customer Credit Awal</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">{formatRupiah(refund.creditNoteCustomerCreditAmount)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Saldo Ledger</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">{formatRupiah(refund.ledgerBalance)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Direservasi Pending</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">{formatRupiah(refund.pendingReserved)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Saldo Tersedia</p>
            <p className="mt-1 text-sm font-bold text-gray-900">{formatRupiah(refund.availableBalance)}</p>
          </div>
        </div>
        {refund.isReversed && <p className="mt-2 text-xs text-amber-600">Credit note sumber refund ini sudah direverse.</p>}
      </div>
    </div>
  );
}
