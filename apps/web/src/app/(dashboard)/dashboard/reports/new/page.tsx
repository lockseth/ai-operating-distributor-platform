import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { SalesReportForm } from "@/components/sales-reports/sales-report-form";
import { createSalesReportAction } from "@/lib/sales-reports/actions";
import { getDailyGovernedKpiSummary, getDailySoldItems } from "@/lib/sales-reports/queries";

export const metadata = { title: "Buat Laporan Sales — AODP" };

interface UserWithRoles {
  id: string;
  full_name: string;
  user_roles: { role: { name: string } | null }[];
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default async function NewSalesReportPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "reports.create")) redirect("/dashboard/reports");

  const supabase = await createClient();

  const { data: usersData } = await supabase
    .from("users")
    .select("id, full_name, user_roles!user_id(role:roles(name))")
    .eq("company_id", user.company_id)
    .eq("is_active", true)
    .order("full_name");

  const salesUsers = ((usersData ?? []) as unknown as UserWithRoles[])
    .filter((u) => u.user_roles?.some((ur) => ur.role?.name === "sales"))
    .map((u) => ({ id: u.id, full_name: u.full_name }));

  // Role sales murni melapor atas nama sendiri; owner/manager/admin memilih sales
  const canReportForOthers = hasRole(user.roles, ["owner", "manager", "admin", "super_admin"]);
  const selfSalespersonId  = canReportForOthers ? null : user.id;

  const initialPreview = selfSalespersonId
    ? {
        kpi: await getDailyGovernedKpiSummary(user.company_id, selfSalespersonId, todayISO()),
        items: await getDailySoldItems(user.company_id, selfSalespersonId, todayISO()),
      }
    : { kpi: { call: 0, effectiveCall: 0, orderCount: 0, revenue: 0, noo: 0 }, items: [] };

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <PageHeader
        title="Buat Laporan Sales"
        subtitle="Ringkasan KPI otomatis dari sistem + catatan kualitatif harian"
      />
      <SalesReportForm
        salesUsers={salesUsers}
        selfSalespersonId={selfSalespersonId}
        initialPreview={initialPreview}
        action={createSalesReportAction}
        cancelHref="/dashboard/reports"
      />
    </div>
  );
}
