import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { DashboardShell, StatCard, AlertCard } from "@/components/layout/dashboard-shell";

export const metadata = { title: "Finance Dashboard — AODP" };

export default async function FinanceDashboardPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("finance") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  // Catatan (Payment/Invoiced Status Integrity Containment Gate):
  // sales_orders.status = 'paid'/'invoiced' BUKAN fakta pembayaran/invoice --
  // lihat migration 20260824000001 (paid) & 20260825000001 (invoiced), serta
  // Payment Proof Discovery Gate dan Collection Receivable-Invoice-Payment
  // Boundary Discovery Gate. Payment ledger & receivable/invoice ledger
  // terverifikasi belum ada, jadi kartu finansial di dashboard ini TIDAK
  // dihitung dari status order sama sekali -- tidak diganti sumber lain
  // apa pun sampai ledger canonical dibangun pada gate mendatang.

  return (
    <DashboardShell
      title={`Selamat datang, ${user.email}`}
      subtitle={`${user.company.name} — Finance Dashboard`}
    >
      <div className="grid grid-cols-1 gap-4">
        <StatCard
          label="Pembayaran Terverifikasi"
          value="Belum tersedia"
          description="Payment ledger belum aktif — status order 'paid' tidak dihitung sebagai pembayaran diterima"
          accent="amber"
        />
      </div>
      <div className="mt-6">
        <AlertCard
          type="info"
          title="Modul Finance"
          message="Invoice management, payment ledger terverifikasi, rekonsiliasi, dan laporan keuangan akan aktif di fase berikutnya."
        />
      </div>
    </DashboardShell>
  );
}
