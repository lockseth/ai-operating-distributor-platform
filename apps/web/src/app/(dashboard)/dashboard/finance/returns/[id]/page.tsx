// =============================================================================
// Gate 2I.3 -- Retur & Credit Note: detail (kontrak §5.5/§8). Preview
// applied_amount/customer_credit_amount (label "Estimasi") HANYA sebelum
// approve, dihitung dari invoice_lines immutable dengan formula identik
// verify_return_atomic (kontrak §5.5 "read-only query, bukan re-implementasi
// formula RPC di client"). Begitu approved, angka final SELALU dibaca dari
// credit_notes -- tidak pernah dari preview. Cross-tenant: getReturnDetail()
// scoped company_id + RLS -> null untuk return milik company lain.
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getReturnDetail, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { VerifyReturnPanel } from "@/components/finance/return-panels";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Detail Retur — AODP" };

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
        message="Detail retur membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const ret = await getReturnDetail(user.company_id, id);
  if (!ret) notFound();

  const canVerify = hasPermission(user.permissions, "return.verify");

  return (
    <div className="space-y-5">
      <PageHeader title={`Retur — ${ret.invoiceNumber}`} subtitle={ret.customerName}>
        {ret.status === "requested" && <VerifyReturnPanel returnId={ret.id} canVerify={canVerify} />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Status</p>
          <p className="mt-1">
            <StatusBadge status={ret.status} domain="return" />
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Diajukan Oleh</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{ret.requestedByName}</p>
          <p className="text-xs text-gray-400">{formatJakartaDateTime(ret.requestedAt)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Diputuskan Oleh</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{ret.decidedByName ?? "—"}</p>
          {ret.decidedAt && <p className="text-xs text-gray-400">{formatJakartaDateTime(ret.decidedAt)}</p>}
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Invoice Asal</p>
          <Link
            href={`/dashboard/finance/invoices/${ret.invoiceId}`}
            className="mt-1 block font-mono text-sm font-semibold text-blue-600 hover:underline"
          >
            {ret.invoiceNumber}
          </Link>
        </div>
      </div>

      {ret.status === "rejected" && (
        <AlertCard
          type="info"
          title="Ditolak — Invoice tidak berubah"
          message="Retur ini ditolak. Tidak ada perubahan pada invoice, piutang, atau ledger."
        />
      )}

      <div>
        <SectionHeader title="Alasan & Bukti" />
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs">
          <p>
            <span className="text-gray-400">Alasan:</span> <span className="text-gray-700">{ret.reasonCode}</span>
          </p>
          <p className="mt-1">
            <span className="text-gray-400">Bukti:</span> <span className="text-gray-700">{ret.proofReference}</span>
          </p>
        </div>
      </div>

      <div>
        <SectionHeader title="Item yang Diretur" />
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {ret.items.length === 0 ? (
            <p className="text-xs text-gray-400">Tidak ada item.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {ret.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-2.5">
                  <div>
                    <p className="font-medium text-gray-800">{item.productName}</p>
                    <p className="text-gray-400">
                      Ditagih: {item.invoicedQuantity} {item.unit ?? ""} · Diretur: {item.requestedQuantity} {item.unit ?? ""}
                    </p>
                  </div>
                  <span className="font-semibold text-gray-900">{formatRupiah(item.lineAmountPreview)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <SectionHeader
          title={ret.creditNote ? "Credit Note" : "Estimasi Nilai Retur"}
          description={ret.creditNote ? undefined : "Estimasi -- nilai final ditentukan server saat retur disetujui."}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Total Nilai Retur</p>
            <p className="mt-1 text-sm font-bold text-gray-900">{formatRupiah(ret.creditNote?.totalAmount ?? ret.totalPreview)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Diterapkan ke Piutang</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">
              {formatRupiah(ret.creditNote?.appliedAmount ?? ret.appliedAmountPreview)}
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-400">Customer Credit</p>
            <p className="mt-1 text-sm font-semibold text-gray-700">
              {formatRupiah(ret.creditNote?.customerCreditAmount ?? ret.customerCreditAmountPreview)}
            </p>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-400">Outstanding invoice saat ini: {formatRupiah(ret.outstandingBalance)}</p>
        {ret.creditNote && ret.creditNote.customerCreditAmount > 0 && (
          <Link href="/dashboard/finance/credit" className="mt-2 inline-block text-xs font-semibold text-blue-600 hover:underline">
            Lihat saldo customer credit →
          </Link>
        )}
      </div>
    </div>
  );
}
