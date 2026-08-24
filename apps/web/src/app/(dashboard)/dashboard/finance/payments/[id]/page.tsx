// =============================================================================
// Gate 2I.2 -- Pembayaran & Verifikasi: detail (kontrak §5.3/§5.4/§7).
// "Rekonsiliasi" hanya tampil bila BELUM ada baris payment_reconciliations
// sama sekali -- rekonsiliasi berikutnya (koreksi) dilakukan dari halaman
// Exception Rekonsiliasi. Cross-tenant: getPaymentReceiptDetail() scoped
// company_id + RLS -> null untuk payment_receipt milik company lain.
// =============================================================================

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { getPaymentReceiptDetail, getReconciliationHistory, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { ReconcileButton } from "@/components/finance/reconcile-button";
import { formatRupiah } from "@/lib/document-engine/monetary";
import { formatJakartaDateTime } from "@/lib/audit-log/format";

export const metadata = { title: "Detail Pembayaran — AODP" };

const METHOD_LABELS: Record<string, string> = { cash: "Tunai", bank_transfer: "Transfer Bank" };
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".heic"];
const PROOF_SIGNED_URL_EXPIRY_SECONDS = 300;

/**
 * Coba buat signed URL untuk objectReference sebagai path di bucket
 * payment-proofs -- baris LAMA (dibuat sebelum perbaikan upload sungguhan,
 * 2026-08-24) isinya teks bebas/link ketikan manual, BUKAN path storage
 * valid, jadi createSignedUrl akan gagal untuk baris itu -- pemanggil
 * fallback tampilkan sebagai teks biasa. Tidak perlu flag kolom/migrasi
 * data untuk membedakan gaya lama vs baru.
 */
async function resolveProofSignedUrl(
  supabase: Awaited<ReturnType<typeof createClient>>,
  objectReference: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from("payment-proofs")
    .createSignedUrl(objectReference, PROOF_SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
        message="Detail pembayaran membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const receipt = await getPaymentReceiptDetail(user.company_id, id);
  if (!receipt) notFound();

  const history = await getReconciliationHistory(user.company_id, id);
  const canReconcile = hasPermission(user.permissions, "payment.reconcile");

  const supabase = await createClient();
  const proofSignedUrls = await Promise.all(
    receipt.proofs.map((p) => resolveProofSignedUrl(supabase, p.objectReference)),
  );

  return (
    <div className="space-y-5">
      <PageHeader title={`Pembayaran ${receipt.id.slice(0, 8)}…`} subtitle={receipt.customerName}>
        {history.length === 0 && <ReconcileButton paymentReceiptId={receipt.id} canReconcile={canReconcile} />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Metode</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{METHOD_LABELS[receipt.method] ?? receipt.method}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Nominal</p>
          <p className="mt-1 text-sm font-bold text-gray-900">{formatRupiah(receipt.amount)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Diterima</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{formatJakartaDateTime(receipt.receivedAt)}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs text-gray-400">Referensi Transfer</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{receipt.transferReference ?? "—"}</p>
        </div>
      </div>

      <div>
        <SectionHeader title="Bukti Pembayaran" />
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {receipt.proofs.length === 0 ? (
            <p className="text-xs text-gray-400">Tidak ada bukti.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {receipt.proofs.map((p, i) => {
                const signedUrl = proofSignedUrls[i];
                const isImage = IMAGE_EXTENSIONS.some((ext) => p.objectReference.toLowerCase().endsWith(ext));
                return (
                  <li key={p.id} className="flex items-center gap-3">
                    <span className="font-medium text-gray-600">{p.proofType}</span>
                    {signedUrl ? (
                      isImage ? (
                        <a href={signedUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element -- signed URL sementara, bukan aset statis */}
                          <img src={signedUrl} alt="Bukti pembayaran" className="h-14 w-14 rounded-lg border border-gray-200 object-cover" />
                        </a>
                      ) : (
                        <a href={signedUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline">
                          Lihat Bukti (PDF)
                        </a>
                      )
                    ) : (
                      <span className="truncate text-gray-400">{p.objectReference}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div>
        <SectionHeader title="Alokasi Invoice" />
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {receipt.allocations.length === 0 ? (
            <p className="text-xs text-gray-400">Tidak ada alokasi.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {receipt.allocations.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <Link href={`/dashboard/finance/invoices/${a.invoiceId}`} className="font-mono text-blue-600 hover:underline">
                    {a.invoiceNumber}
                  </Link>
                  <span className="font-medium text-gray-700">{formatRupiah(a.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <SectionHeader title="Riwayat Rekonsiliasi" description="Setiap rekonsiliasi/koreksi tercatat sebagai baris baru (append-only)." />
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          {history.length === 0 ? (
            <p className="text-xs text-gray-400">Belum pernah direkonsiliasi.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-2.5 text-xs">
                  <div>
                    <StatusBadge status={h.classification} domain="payment_reconciliation" />
                    <p className="mt-1 text-gray-500">{formatJakartaDateTime(h.createdAt)}</p>
                    {h.reason && <p className="mt-0.5 text-gray-400">Alasan: {h.reason}</p>}
                  </div>
                  <div className="text-right text-gray-500">
                    <p>Teralokasi: {formatRupiah(h.totalAllocated)}</p>
                    <p>Belum teralokasi: {formatRupiah(h.unallocatedAmount)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
