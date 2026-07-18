import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiAchievementView } from "@/components/sales-kpi/kpi-achievement-view";

export const metadata = { title: "KPI Salesman — AODP" };

interface PeriodRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface SalesmanOption {
  id: string;
  fullName: string;
}

export default async function SalesKpiPage() {
  const user = await getAuthUser();

  const canManage =
    hasPermission(user.permissions, "sales_kpi.manage") ||
    hasRole(user.roles, ["owner", "manager", "super_admin"]);
  const canView =
    canManage || hasPermission(user.permissions, "sales_kpi.view") || hasRole(user.roles, ["sales"]);
  if (!canView) redirect("/dashboard");

  const supabase = await createClient();

  const { data: periodRows } = await supabase
    .from("sales_kpi_periods")
    .select("id, name, start_date, end_date, status")
    .eq("company_id", user.company_id)
    .order("start_date", { ascending: false });

  const periods = (periodRows ?? []) as PeriodRow[];

  let salesmen: SalesmanOption[] = [];
  if (canManage) {
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", user.company_id);

    const rows = (roleRows ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean } | null;
      role: { name: string } | null;
    }[];

    salesmen = rows
      .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
      .map((r) => ({ id: r.user!.id, fullName: r.user!.full_name }));
  }

  return (
    <div>
      <PageHeader
        title="KPI Salesman"
        subtitle="Achievement Call & Effective Call -- selalu dihitung otomatis dari kunjungan dan Sales Order confirmed. Tidak dapat diinput atau di-override manual."
      />

      {periods.length === 0 ? (
        <EmptyState
          title="Belum ada periode KPI"
          description="Owner/Manager perlu membuat periode dan target KPI terlebih dahulu sebelum achievement dapat ditampilkan."
        />
      ) : (
        <KpiAchievementView
          periods={periods.map((p) => ({
            id: p.id,
            name: p.name,
            startDate: p.start_date,
            endDate: p.end_date,
            status: p.status,
          }))}
          salesmen={salesmen}
          canManage={canManage}
          selfId={user.id}
          isSelfSalesperson={hasRole(user.roles, ["sales"])}
        />
      )}
    </div>
  );
}
