// =============================================================================
// Gate 2I.2 -- Exception Rekonsiliasi (kontrak §5.4). List selalu dari view
// payment_reconciliation_exceptions (classification != matched, latest-state
// projection) -- riwayat penuh per payment_receipt_id dibaca terpisah dari
// payment_reconciliations (append-only, FIN-04-04).
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getReconciliationExceptionList,
  getReconciliationHistory,
  hasFinanceWorkspaceAccess,
  type ReconciliationHistoryEntry,
} from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { ReconciliationPanel } from "@/components/finance/reconciliation-panel";

export const metadata = { title: "Exception Rekonsiliasi — AODP" };

export default async function ReconciliationExceptionPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Exception Rekonsiliasi membaca dan mengubah data finansial nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  let exceptions: Awaited<ReturnType<typeof getReconciliationExceptionList>> = [];
  let historyByReceipt: Record<string, ReconciliationHistoryEntry[]> = {};
  let loadError = false;
  try {
    exceptions = await getReconciliationExceptionList(user.company_id);
    const histories = await Promise.all(
      exceptions.map((e) => getReconciliationHistory(user.company_id, e.paymentReceiptId))
    );
    historyByReceipt = Object.fromEntries(exceptions.map((e, i) => [e.paymentReceiptId, histories[i]]));
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Exception Rekonsiliasi"
        subtitle="Pembayaran yang hasil rekonsiliasinya bukan matched -- perlu koreksi/tindak lanjut."
      />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat exception rekonsiliasi</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : (
        <ReconciliationPanel
          exceptions={exceptions}
          historyByReceipt={historyByReceipt}
          canReconcile={hasPermission(user.permissions, "payment.reconcile")}
        />
      )}
    </div>
  );
}
