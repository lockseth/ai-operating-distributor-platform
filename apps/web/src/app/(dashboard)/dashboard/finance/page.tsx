import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Finance Dashboard — AODP" };

export default async function FinanceDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("finance") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const firstOfMonth = new Date();
  firstOfMonth.setDate(1);
  firstOfMonth.setHours(0, 0, 0, 0);

  const [{ data: paidData }, { data: invoicedData }] = await Promise.all([
    supabase
      .from("sales_orders")
      .select("final_amount")
      .eq("company_id", user.company_id)
      .eq("status", "paid")
      .gte("created_at", firstOfMonth.toISOString()),
    supabase
      .from("sales_orders")
      .select("final_amount")
      .eq("company_id", user.company_id)
      .eq("status", "invoiced"),
  ]);

  const paid = ((paidData ?? []) as { final_amount: number }[]).reduce(
    (s, r) => s + (r.final_amount ?? 0),
    0
  );
  const invoiced = ((invoicedData ?? []) as { final_amount: number }[]).reduce(
    (s, r) => s + (r.final_amount ?? 0),
    0
  );

  function formatIDR(v: number) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(v);
  }

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Finance Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Pembayaran Diterima (Bulan Ini)"
          value={formatIDR(paid)}
          description="Status: paid"
          accent="green"
        />
        <StatCard
          label="Piutang Invoice"
          value={formatIDR(invoiced)}
          description="Belum dibayar — status: invoiced"
          accent={invoiced > 10_000_000 ? "red" : "amber"}
        />
      </div>
      <div className="mt-6">
        <AlertCard
          type="info"
          title="Modul Finance"
          message="Invoice management, rekonsiliasi, dan laporan keuangan akan aktif di fase berikutnya."
        />
      </div>
    </DashboardShell>
  );
}
