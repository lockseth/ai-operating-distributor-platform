// =============================================================================
// Gate P4.06 -- Klaim Pembayaran (sisi sales/driver). Lapor pembayaran yang
// diterima langsung dari customer + lihat status laporan sendiri. TIDAK
// menyentuh receivable_ledger -- lihat submit_payment_claim_atomic.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getOutstandingInvoices, getPaymentClaimList, type PaymentClaimListItem } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { SubmitPaymentClaimForm } from "@/components/finance/submit-payment-claim-form";
import { RecordCollectionFieldOutcomeForm } from "@/components/finance/record-collection-field-outcome-form";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Klaim Pembayaran — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };

function ClaimCard({ item }: { item: PaymentClaimListItem }) {
  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{item.customerName}</p>
          <p className="mt-0.5 text-xs text-gray-500">{formatJakartaDateTime(item.claimedAt)}</p>
        </div>
        <StatusBadge status={item.status} domain="payment_claim" />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div>
          <dt className="text-gray-400">Metode</dt>
          <dd className="text-gray-700">{METHOD_LABELS[item.method] ?? item.method}</dd>
        </div>
        <div>
          <dt className="text-gray-400">Nominal</dt>
          <dd className="font-semibold text-gray-900">{formatRupiah(item.amount)}</dd>
        </div>
      </dl>
      {item.status === "REJECTED" && item.rejectionReason && (
        <p className="mt-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700">Alasan ditolak: {item.rejectionReason}</p>
      )}
    </li>
  );
}

export default async function PaymentClaimsSalesPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "payment.claim")) {
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id, name")
    .eq("company_id", user.company_id)
    .eq("is_active", true)
    .order("name");
  const customers = (customerRows ?? []) as { id: string; name: string }[];

  let claims: PaymentClaimListItem[] = [];
  let outstandingInvoices: Awaited<ReturnType<typeof getOutstandingInvoices>> = [];
  let loadError = false;
  try {
    // Sales/driver TIDAK punya permission receivable.view (RLS invoices_select),
    // memang sengaja sempit -- itu kewenangan finance/owner/manager. Query
    // invoice outstanding di sini pakai admin client (bypass RLS) TAPI tetap
    // aman: hasilnya cuma dipakai sebagai referensi/informasi (bukan alokasi
    // ledger), dan UI di SubmitPaymentClaimForm cuma menampilkan invoice utk
    // customer yang sudah dipilih dari dropdown -- dropdown itu sendiri masih
    // RLS-scoped (query customers di atas, session client), jadi sales tetap
    // cuma bisa lihat/tandai invoice milik customer yang memang jadi
    // tanggung jawabnya, bukan invoice customer lain sembarangan.
    [claims, outstandingInvoices] = await Promise.all([
      getPaymentClaimList(user.company_id, { claimedBy: user.id }),
      getOutstandingInvoices(user.company_id, {}, getAdminClient()),
    ]);
  } catch {
    loadError = true;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <PageHeader
        title="Klaim Pembayaran"
        subtitle="Laporkan pembayaran (cash/transfer) yang Anda terima langsung dari customer -- akan diperiksa Owner/Finance sebelum dianggap resmi."
      />

      <SubmitPaymentClaimForm customers={customers} outstandingInvoices={outstandingInvoices} />

      {hasPermission(user.permissions, "collection.record.field") && (
        <RecordCollectionFieldOutcomeForm customers={customers} outstandingInvoices={outstandingInvoices} />
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-900">Riwayat Laporan Saya</h2>
        {loadError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-sm font-semibold text-red-700">Gagal memuat riwayat laporan</p>
            <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
          </div>
        ) : claims.length === 0 ? (
          <EmptyState title="Belum ada laporan" description="Laporan pembayaran yang Anda kirim akan muncul di sini." />
        ) : (
          <ul className="space-y-2">
            {claims.map((item) => (
              <ClaimCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
