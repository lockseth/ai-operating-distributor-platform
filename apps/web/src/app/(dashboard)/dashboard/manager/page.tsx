import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Manager Dashboard — AODP" };

export default async function ManagerDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("manager") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);

  const [
    { count: totalOrders },
    { count: totalCustomers },
    { count: pendingOrders },
  ] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .gte("created_at", firstOfMonth.toISOString()),
    supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id),
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .in("status", ["pending", "confirmed"]),
  ]);

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Manager Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Order Bulan Ini"
          value={(totalOrders ?? 0).toLocaleString("id-ID")}
          description="Total sales order bulan ini"
          accent="blue"
        />
        <StatCard
          label="Total Reseller"
          value={(totalCustomers ?? 0).toLocaleString("id-ID")}
          description="Semua reseller aktif"
          accent="green"
        />
        <StatCard
          label="Order Pending"
          value={(pendingOrders ?? 0).toLocaleString("id-ID")}
          description="Perlu konfirmasi"
          accent={pendingOrders && pendingOrders > 10 ? "red" : "amber"}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AlertCard
          type="info"
          title="Monitoring Sales Team"
          message="Lihat performa per sales di menu Laporan. Data real-time tersedia."
        />
        <AlertCard
          type="ai"
          title="AI Sales Recommendation"
          message="Fitur rekomendasi tindakan harian untuk sales akan aktif di Priority 5."
        />
      </div>
    </DashboardShell>
  );
}
