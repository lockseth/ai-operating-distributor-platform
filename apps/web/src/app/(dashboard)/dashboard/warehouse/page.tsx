import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Warehouse Dashboard — AODP" };

export default async function WarehouseDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("warehouse") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const [{ count: toDeliver }, { count: deliveredToday }] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .in("status", ["confirmed", "delivering"]),
    supabase
      .from("sales_orders")
      .select("*", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("status", "delivered")
      .gte(
        "delivered_at",
        new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
      ),
  ]);

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Warehouse Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Perlu Dikirim"
          value={(toDeliver ?? 0).toLocaleString("id-ID")}
          description="Order confirmed + dalam pengiriman"
          accent={toDeliver && toDeliver > 20 ? "red" : "amber"}
        />
        <StatCard
          label="Terkirim Hari Ini"
          value={(deliveredToday ?? 0).toLocaleString("id-ID")}
          description="Order delivered hari ini"
          accent="green"
        />
      </div>
      <div className="mt-6">
        <AlertCard
          type="info"
          title="Manajemen Pengiriman"
          message="Modul pengiriman lengkap (jadwal, rute, driver) akan aktif di fase berikutnya."
        />
      </div>
    </DashboardShell>
  );
}
