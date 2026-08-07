import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
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
      />
    </div>
  );
}
