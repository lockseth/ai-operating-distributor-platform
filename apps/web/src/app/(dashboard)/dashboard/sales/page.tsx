import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Sales Dashboard — AODP" };

export default async function SalesDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("sales") &&
    !user.roles.includes("manager") &&
    !user.roles.includes("owner") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);

  const [
    { count: myOrdersToday },
    { count: myOrdersMonth },
    { count: myCustomers },
  ] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("sales_id", user.id)
      .gte("created_at", today.toISOString()),
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("sales_id", user.id)
      .gte("created_at", firstOfMonth.toISOString()),
    supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("assigned_sales_id", user.id),
  ]);

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Sales Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Order Hari Ini"
          value={(myOrdersToday ?? 0).toLocaleString("id-ID")}
          description="Order yang Anda buat hari ini"
          accent="blue"
        />
        <StatCard
          label="Order Bulan Ini"
          value={(myOrdersMonth ?? 0).toLocaleString("id-ID")}
          description="Total order bulan ini"
          accent="green"
        />
        <StatCard
          label="Reseller Saya"
          value={(myCustomers ?? 0).toLocaleString("id-ID")}
          description="Reseller yang ditugaskan ke Anda"
          accent="purple"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AlertCard
          type="info"
          title="Tugas Hari Ini"
          message="Cek reseller yang belum order bulan ini di menu Pelanggan. Filter: Dormant."
        />
        <AlertCard
          type="ai"
          title="AI Priority Customer"
          message="Fitur prioritas kunjungan berbasis AI akan aktif di Priority 5."
        />
      </div>
    </DashboardShell>
  );
}
