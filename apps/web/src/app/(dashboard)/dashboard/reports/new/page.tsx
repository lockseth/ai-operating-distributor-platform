import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { SalesReportForm } from "@/components/sales-reports/sales-report-form";
import { createSalesReportAction } from "@/lib/sales-reports/actions";

export const metadata = { title: "Buat Laporan Sales — AODP" };

interface UserWithRoles {
  id: string;
  full_name: string;
  user_roles: { role: { name: string } | null }[];
}

export default async function NewSalesReportPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "reports.create")) redirect("/dashboard/reports");

  const supabase = await createClient();

  const [productsResult, usersResult] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, unit")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("users")
      .select("id, full_name, user_roles(role:roles(name))")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const products = (productsResult.data ?? []) as { id: string; name: string; unit: string }[];

  const salesUsers = ((usersResult.data ?? []) as unknown as UserWithRoles[])
    .filter((u) => u.user_roles?.some((ur) => ur.role?.name === "sales"))
    .map((u) => ({ id: u.id, full_name: u.full_name }));

  // Role sales murni melapor atas nama sendiri; owner/manager/admin memilih sales
  const canReportForOthers = hasRole(user.roles, ["owner", "manager", "admin", "super_admin"]);
  const selfSalespersonId  = canReportForOthers ? null : user.id;

  return (
    <div className="p-6 space-y-5 max-w-4xl">
      <PageHeader
        title="Buat Laporan Sales"
        subtitle="Input laporan harian: target, pencapaian, dan produk terjual"
      />
      <SalesReportForm
        products={products}
        salesUsers={salesUsers}
        selfSalespersonId={selfSalespersonId}
        action={createSalesReportAction}
        cancelHref="/dashboard/reports"
      />
    </div>
  );
}
