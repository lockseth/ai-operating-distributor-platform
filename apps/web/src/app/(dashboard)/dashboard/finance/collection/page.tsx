// =============================================================================
// Gate 2I.2 -- Collection & Janji Bayar (kontrak §5.2). Aksi eksekusi tetap
// dicek server-side lewat hasPermission() di actions.ts (defense kedua) --
// canRecord/canPromise di sini murni UI-layer (§4 catatan 1: tombol non-
// permission dirender disabled dengan alasan, bukan disembunyikan).
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getCollectionActivityList,
  getOutstandingInvoices,
  getPromiseList,
  hasFinanceWorkspaceAccess,
} from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { CollectionPanel } from "@/components/finance/collection-panel";

export const metadata = { title: "Collection & Janji Bayar — AODP" };

export default async function CollectionPage() {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Collection & Janji Bayar membaca dan mengubah data finansial nyata perusahaan, belum didukung pada sesi demo."
      />
    );
  }

  let promises: Awaited<ReturnType<typeof getPromiseList>> = [];
  let activities: Awaited<ReturnType<typeof getCollectionActivityList>> = [];
  let outstandingInvoices: Awaited<ReturnType<typeof getOutstandingInvoices>> = [];
  let loadError = false;
  try {
    [promises, activities, outstandingInvoices] = await Promise.all([
      getPromiseList(user.company_id),
      getCollectionActivityList(user.company_id),
      getOutstandingInvoices(user.company_id),
    ]);
  } catch {
    loadError = true;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Collection & Janji Bayar" subtitle="Kelola janji bayar dan riwayat aktivitas collection per invoice." />

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat data collection</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : (
        <CollectionPanel
          promises={promises}
          activities={activities}
          outstandingInvoices={outstandingInvoices}
          canRecord={hasPermission(user.permissions, "collection.record")}
          canPromise={hasPermission(user.permissions, "collection.promise")}
        />
      )}
    </div>
  );
}
