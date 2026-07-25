// =============================================================================
// Gate 2I.1 -- Finance Operations: Ringkasan / Perlu Tindakan (read-only).
//
// Tidak ada mutation di halaman ini. Demo mode TIDAK didukung (kontrak §1.2,
// keputusan dibekukan) -- banner ditampilkan, tidak ada fetch data sama
// sekali untuk sesi demo. Kegagalan getFinanceActionQueue() ditangani sebagai
// error state eksplisit (bukan dianggap "0 tindakan").
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { getFinanceActionQueue, hasFinanceWorkspaceAccess, type FinanceActionQueueResult } from "@/lib/finance/queries";
import { ActionQueueSection } from "@/components/finance/action-queue";
import { AlertCard } from "@/components/layout/dashboard-shell";

export const metadata = { title: "Finance Operations — AODP" };

export default async function FinanceWorkspacePage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Finance Operations Workspace membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  let queue: FinanceActionQueueResult | null = null;
  let loadError = false;
  try {
    queue = await getFinanceActionQueue(user.company_id);
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Perlu Tindakan</h2>
        <p className="text-xs text-gray-500">
          {loadError
            ? "Jumlah tindakan tidak dapat ditampilkan saat ini."
            : `${queue?.items.length ?? 0} tindakan perlu perhatian`}
        </p>
      </div>

      <ActionQueueSection
        items={queue?.items ?? []}
        failedCategories={queue?.failedCategories ?? []}
        loadError={loadError}
      />
    </div>
  );
}
