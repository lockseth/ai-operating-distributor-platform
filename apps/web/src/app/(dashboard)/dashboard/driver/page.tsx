import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Driver Dashboard — AODP" };

export default async function DriverDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("driver") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const { count: deliveringOrders } = await supabase
    .from("sales_orders")
    .select("*", { count: "exact", head: true })
    .eq("company_id", user.company_id)
    .eq("status", "delivering");

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Driver Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Pengiriman Aktif"
          value={(deliveringOrders ?? 0).toLocaleString("id-ID")}
          description="Order sedang dalam pengiriman"
          accent="blue"
        />
      </div>
      <div className="mt-6 rounded-xl border border-gray-100 bg-gray-50 p-5">
        <p className="text-sm font-medium text-gray-700">Modul Pengiriman</p>
        <p className="mt-1 text-sm text-gray-500">
          Fitur konfirmasi pengiriman, foto bukti, dan notifikasi pelanggan akan aktif di fase berikutnya.
        </p>
      </div>
    </DashboardShell>
  );
}
