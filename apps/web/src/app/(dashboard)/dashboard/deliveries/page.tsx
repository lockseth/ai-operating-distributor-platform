import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { INVOICE_APPROVER_ROLES } from "@/lib/finance/invoice-approval";
import { getAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Pengiriman — AODP" };

const ACTIVE_STATUSES = ["planned", "dispatched", "arrived"];
const STATUS_LABEL: Record<string, string> = {
  planned: "Siap diantar",
  dispatched: "Sedang diantar",
  arrived: "Sudah tiba",
};

interface TaskRow {
  id: string;
  status: string;
  attempt_number: number;
  sales_order: { order_number: string; customer: { name: string; address: string | null } | null } | null;
}

export default async function DeliveriesPage() {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "delivery.view")) redirect("/dashboard");

  const canManage = hasPermission(user.permissions, "delivery.manage");
  let query = getAdminClient()
    .from("deliveries")
    .select("id, status, attempt_number, sales_order:sales_orders!sales_order_id(order_number, customer:customers!customer_id(name, address))")
    .eq("company_id", user.company_id)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false });
  // Pengantar hanya melihat tugasnya sendiri; admin/owner melihat semua.
  if (!canManage) query = query.eq("assigned_driver_id", user.id);
  const { data } = await query;
  const tasks = (data ?? []) as unknown as TaskRow[];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-2xl">
      <PageHeader title="Pengiriman" subtitle={canManage ? "Semua tugas pengiriman yang sedang berjalan" : "Tugas pengiriman Anda"} />
      {hasRole(user.roles, INVOICE_APPROVER_ROLES) && (
        <Link href="/dashboard/deliveries/audits" className="inline-block text-sm font-semibold text-blue-600 underline">Audit Pengiriman (cek acak ke toko)</Link>
      )}
      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          Belum ada tugas pengiriman.
        </p>
      ) : (
        <ul className="space-y-3">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link href={`/dashboard/deliveries/${t.id}`} className="block rounded-xl border border-gray-200 bg-white p-4 shadow-sm active:bg-gray-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-gray-900">{t.sales_order?.customer?.name ?? "Toko"}</p>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">{STATUS_LABEL[t.status] ?? t.status}</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{t.sales_order?.order_number}{t.attempt_number > 1 ? ` · percobaan #${t.attempt_number}` : ""}</p>
                {t.sales_order?.customer?.address && <p className="mt-1 text-sm text-gray-600">{t.sales_order.customer.address}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
