import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole, hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { getOutstandingInvoices, type OutstandingInvoiceOption } from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { SalesVisitWorkspace } from "@/components/sales-visits/sales-visit-workspace";
import { getSalesVisitDataAction } from "@/lib/sales-visits/actions";

export const metadata = { title: "Kunjungan Sales — AODP" };

export default async function SalesVisitsPage() {
  const user = await getAuthUser();

  // Gate 3E-D5-B — menu Kunjungan Sales khusus role Sales (lock produk).
  if (!hasRole(user.roles, "sales")) redirect("/dashboard");

  const supabase = await createClient();
  const { data: customerRows } = await supabase
    .from("customers")
    .select("id, name, address")
    .eq("company_id", user.company_id)
    .eq("is_active", true)
    .order("name");

  const customers = ((customerRows ?? []) as { id: string; name: string; address: string | null }[]);

  const visitData = await getSalesVisitDataAction();

  // Gate P4.21 follow-up: kunjungan bertujuan Penagihan yang berhasil ketemu
  // toko bisa langsung lanjut catat hasil penagihan ATAU lapor pembayaran
  // diterima di form yang sama (lihat sales-visit-workspace.tsx) -- invoice
  // outstanding perlu admin client, pola identik dashboard/payment-claims/
  // page.tsx (sales tidak punya receivable.view, cuma dipakai sebagai
  // referensi pilihan invoice).
  const canRecordCollectionField = hasPermission(user.permissions, "collection.record.field");
  const canClaimPayment = hasPermission(user.permissions, "payment.claim");
  let outstandingInvoices: OutstandingInvoiceOption[] = [];
  if (canRecordCollectionField || canClaimPayment) {
    try {
      outstandingInvoices = await getOutstandingInvoices(user.company_id, {}, getAdminClient());
    } catch {
      outstandingInvoices = [];
    }
  }

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <PageHeader
        title="Kunjungan Sales"
        subtitle="Catat kunjungan ke toko dan dapatkan achievement CALL & Effective Call secara otomatis"
      />
      <SalesVisitWorkspace
        customers={customers}
        initialActiveVisit={visitData.ok ? visitData.activeVisit ?? null : null}
        initialHistory={visitData.ok ? visitData.history ?? [] : []}
        outstandingInvoices={outstandingInvoices}
        canClaimPayment={canClaimPayment}
      />
    </div>
  );
}
