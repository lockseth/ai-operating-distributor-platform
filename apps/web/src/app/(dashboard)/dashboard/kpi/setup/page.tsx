import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { KpiSetupView } from "@/components/sales-kpi/kpi-setup-view";

export const metadata = { title: "KPI Setup & Kalibrasi — AODP" };

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

export default async function SalesKpiSetupPage() {
  const user = await getAuthUser();

  const canManage =
    hasPermission(user.permissions, "sales_kpi.manage") ||
    hasRole(user.roles, ["owner", "manager", "super_admin"]);
  if (!canManage) redirect("/dashboard/kpi");

  const supabase = await createClient();

  const { count: definitionCount } = await supabase
    .from("sales_kpi_definitions")
    .select("id", { count: "exact", head: true })
    .eq("company_id", user.company_id)
    .is("superseded_at", null);

  const { data: periodRows } = await supabase
    .from("sales_kpi_periods")
    .select("id, name, start_date, end_date, status")
    .eq("company_id", user.company_id)
    .order("start_date", { ascending: false });

  const periods = (periodRows ?? []) as PeriodRow[];

  const { data: roleRows } = await supabase
    .from("user_roles")
    .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
    .eq("company_id", user.company_id);

  const rows = (roleRows ?? []) as unknown as {
    user: { id: string; full_name: string; is_active: boolean } | null;
    role: { name: string } | null;
  }[];

  const salesmen: SalesmanOption[] = rows
    .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
    .map((r) => ({ id: r.user!.id, fullName: r.user!.full_name }));

  return (
    <div>
      <PageHeader
        title="KPI Setup & Kalibrasi Target"
        subtitle="Buat periode, lihat baseline historis Call/EC sebagai evidence, lalu tetapkan target. Achievement tetap otomatis dari data operasional -- tidak ada input manual."
      />
      <KpiSetupView
        periods={periods.map((p) => ({
          id: p.id,
          name: p.name,
          startDate: p.start_date,
          endDate: p.end_date,
          status: p.status,
        }))}
        salesmen={salesmen}
        foundationInitialized={(definitionCount ?? 0) >= 5}
      />
    </div>
  );
}
