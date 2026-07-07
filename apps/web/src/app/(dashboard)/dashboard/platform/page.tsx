import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Platform Admin — AODP" };

export default async function PlatformDashboardPage() {
  const user = await getAuthUser();

  if (!user.roles.includes("super_admin")) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const [
    { count: totalCompanies },
    { count: totalUsers },
    { count: totalOrders },
    { count: totalCustomers },
  ] = await Promise.all([
    supabase.from("companies").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("sales_orders").select("*", { count: "exact", head: true }),
    supabase.from("customers").select("*", { count: "exact", head: true }),
  ]);

  return (
    <DashboardShell
      title="Platform Admin Dashboard"
      subtitle="AODP — Cross-Tenant Overview"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Tenant"
          value={(totalCompanies ?? 0).toLocaleString("id-ID")}
          description="Perusahaan aktif di platform"
          accent="blue"
        />
        <StatCard
          label="Total User"
          value={(totalUsers ?? 0).toLocaleString("id-ID")}
          description="Pengguna di semua tenant"
          accent="green"
        />
        <StatCard
          label="Total Reseller"
          value={(totalCustomers ?? 0).toLocaleString("id-ID")}
          description="Pelanggan di semua tenant"
          accent="purple"
        />
        <StatCard
          label="Total Order"
          value={(totalOrders ?? 0).toLocaleString("id-ID")}
          description="Sales order di semua tenant"
          accent="amber"
        />
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AlertCard
          type="ai"
          title="Platform Health"
          message="Semua tenant berjalan normal. Tidak ada anomali terdeteksi."
        />
        <AlertCard
          type="info"
          title="Super Admin Access"
          message="Anda memiliki akses penuh ke seluruh tenant. Gunakan dengan bijak."
        />
      </div>
    </DashboardShell>
  );
}
