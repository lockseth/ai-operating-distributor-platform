import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Admin Dashboard — AODP" };

export default async function AdminDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("admin") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const [
    { count: totalProducts },
    { count: totalCustomers },
    { count: totalUsers },
  ] = await Promise.all([
    supabase
      .from("products")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("is_active", true),
    supabase
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id),
    supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("is_active", true),
  ]);

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Admin Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Produk Aktif"
          value={(totalProducts ?? 0).toLocaleString("id-ID")}
          description="Produk yang bisa dipesan"
          accent="blue"
        />
        <StatCard
          label="Total Reseller"
          value={(totalCustomers ?? 0).toLocaleString("id-ID")}
          description="Data master pelanggan"
          accent="green"
        />
        <StatCard
          label="Pengguna Aktif"
          value={(totalUsers ?? 0).toLocaleString("id-ID")}
          description="User dalam sistem"
          accent="purple"
        />
      </div>
      <div className="mt-6">
        <AlertCard
          type="info"
          title="Manajemen Data Master"
          message="Kelola produk, pelanggan, dan pengguna melalui menu di sidebar."
        />
      </div>
    </DashboardShell>
  );
}
