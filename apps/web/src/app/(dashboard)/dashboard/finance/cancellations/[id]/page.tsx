// =============================================================================
// Gate 2I.4 -- Cancellation & Invoice Void: detail (kontrak §B.3/§D/§E). Preview
// dampak (§E) HANYA ditampilkan sebelum decision (status='requested') --
// READ-ONLY, formula identik precondition RPC, BUKAN authority. Begitu final
// (approved/rejected), angka/relasi invoice void SELALU dibaca dari
// invoice_voids/receivable_ledger canonical, bukan dihitung ulang. Cross-tenant:
// getCancellationDetail() scoped company_id + RLS -> null untuk cancellation
// milik company lain -> notFound() (pola identik returns/[id]/page.tsx).
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getCancellationDetail, hasFinanceWorkspaceAccess, type CancellationDetail } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { DecideCancellationPanel } from "@/components/finance/cancellation-panels";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Detail Cancellation — AODP" };

function PreviewCard({ cancellation }: { cancellation: CancellationDetail }) {
  const { previewBranch: branch, invoice } = cancellation;

  if (branch === "eligible_no_invoice") {
    return (
      <AlertCard
        type="info"
        title="Order akan dibatalkan tanpa dampak ledger"
        message="Order belum memiliki invoice -- approve hanya mengubah status order menjadi dibatalkan, tanpa ledger apa pun."
      />
    );
  }
  if (branch === "delivery_reversal_required") {
    return (
      <AlertCard
        type="warning"
        title="Diblokir — reversal delivery diperlukan"
        message="Order sudah terkirim (delivered) -- pembatalan memerlukan reversal delivery terlebih dahulu (belum didukung Gate 2G)."
      />
    );
  }
  if (branch === "eligible_full_void" && invoice) {
    return (
      <AlertCard
        type="info"
        title="Approve akan menerbitkan invoice void"
        message={`Approve akan membuat invoice void penuh sebesar ${formatRupiah(invoice.totalAmount)} dan membatalkan order.`}
      />
    );
  }
  if (branch === "settlement_exists" && invoice) {
    const facts = [
      invoice.hasPaymentAllocation ? "sudah ada pembayaran terverifikasi" : null,
      invoice.hasCreditNote ? "sudah ada credit note" : null,
      invoice.outstandingBalance !== invoice.totalAmount
        ? `outstanding (${formatRupiah(invoice.outstandingBalance)}) berbeda dari total invoice (${formatRupiah(invoice.totalAmount)})`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
    return (
      <AlertCard
        type="warning"
        title="Diblokir — invoice sudah tersentuh"
        message={`Invoice ini ${facts}. Pembatalan dengan invoice void tidak dapat dilakukan (bukan retur/credit note/refund).`}
      />
    );
  }
  if (branch === "invoice_record_missing") {
    return (
      <AlertCard
        type="warning"
        title="Diblokir"
        message="Order ini tidak memiliki data invoice yang valid untuk diproses."
      />
    );
  }
  if (branch === "multiple_invoices_unsupported") {
    return (
      <AlertCard type="warning" title="Diblokir" message="Order ini memiliki lebih dari satu invoice — belum didukung." />
    );
  }
  return (
    <AlertCard type="warning" title="Diblokir" message="Status order saat ini tidak dapat diproses untuk pembatalan." />
  );
}

export default async function CancellationDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
        message="Detail cancellation membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const cancellation = await getCancellationDetail(user.company_id, id);
  if (!cancellation) notFound();

  const canDecide = hasPermission(user.permissions, "order_cancellation.approve");
  const auditHref = `/dashboard/finance/audit?entity=order_cancellations&entity_id=${cancellation.id}`;

  return (
    <div className="space-y-5">
      <PageHeader title={`Pembatalan — ${cancellation.orderNumber}`} subtitle={cancellation.customerName}>
        {cancellation.status === "requested" && <DecideCancellationPanel cancellationId={cancellation.id} canDecide={canDecide} />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Status</p>
          <p className="mt-1">
            <StatusBadge status={cancellation.status} domain="cancellation" />
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Diajukan Oleh</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{cancellation.requestedByName}</p>
          <p className="text-xs text-gray-400">{formatJakartaDateTime(cancellation.requestedAt)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Diputuskan Oleh</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{cancellation.decidedByName ?? "—"}</p>
          {cancellation.decidedAt && <p className="text-xs text-gray-400">{formatJakartaDateTime(cancellation.decidedAt)}</p>}
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Order</p>
          <Link
            href={`/dashboard/orders/${cancellation.orderId}`}
            className="mt-1 block font-mono text-sm font-semibold text-blue-600 hover:underline"
          >
            {cancellation.orderNumber}
          </Link>
          <p className="text-xs text-gray-400">
            <StatusBadge status={cancellation.orderStatus} domain="sales_order" />
          </p>
        </div>
      </div>

      {cancellation.status === "rejected" && (
        <AlertCard
          type="info"
          title="Ditolak — Order dan Invoice tidak berubah"
          message="Pengajuan pembatalan ini ditolak. Tidak ada perubahan pada order, invoice, atau ledger."
        />
      )}

      <div>
        <SectionHeader title="Alasan" />
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs">
          <span className="text-gray-700">{cancellation.reasonCode}</span>
        </div>
      </div>

      {cancellation.status === "requested" && (
        <div>
          <SectionHeader title="Preview Dampak" description="Read-only -- RPC tetap memvalidasi ulang saat approve." />
          <PreviewCard cancellation={cancellation} />
        </div>
      )}

      {cancellation.invoice && (
        <div>
          <SectionHeader title="Invoice Terkait" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-400">Nomor Invoice</p>
              <p className="mt-1 font-mono text-sm font-semibold text-gray-800">{cancellation.invoice.invoiceNumber}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-400">Total Invoice</p>
              <p className="mt-1 text-sm font-semibold text-gray-700">{formatRupiah(cancellation.invoice.totalAmount)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-400">Outstanding</p>
              <p className="mt-1 text-sm font-bold text-gray-900">{formatRupiah(cancellation.invoice.outstandingBalance)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-400">Status Finansial</p>
              <p className="mt-1">
                <StatusBadge status={cancellation.invoice.financialStatus} domain="invoice" />
              </p>
            </div>
          </div>
        </div>
      )}

      {cancellation.invoiceVoid && (
        <div>
          <SectionHeader title="Invoice Void" description="Final -- immutable, tidak dapat diubah/dihapus/dibatalkan lagi." />
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-gray-400">Nilai Void</dt>
                <dd className="mt-0.5 font-semibold text-gray-900">{formatRupiah(cancellation.invoiceVoid.voidedAmount)}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Disetujui Oleh</dt>
                <dd className="mt-0.5 text-gray-700">{cancellation.invoiceVoid.approvedByName}</dd>
              </div>
              <div>
                <dt className="text-gray-400">Waktu</dt>
                <dd className="mt-0.5 text-gray-700">{formatJakartaDateTime(cancellation.invoiceVoid.createdAt)}</dd>
              </div>
            </dl>
            {cancellation.invoice && (
              <Link
                href={`/dashboard/finance/invoices/${cancellation.invoice.id}`}
                className="mt-3 inline-block text-xs font-semibold text-blue-600 hover:underline"
              >
                Lihat ledger piutang invoice ini →
              </Link>
            )}
          </div>
        </div>
      )}

      <Link href={auditHref} className="inline-block text-xs font-semibold text-blue-600 hover:underline">
        Lihat riwayat audit untuk pengajuan ini →
      </Link>
    </div>
  );
}
