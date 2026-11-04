import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { INVOICE_APPROVER_ROLES } from "@/lib/finance/invoice-approval";
import { formatIDR } from "@/lib/sales-orders/normalize";
import { PageHeader } from "@/components/ui/page-header";
import { InvoiceApprovalActions } from "@/components/finance/invoice-approval-actions";

export const metadata = { title: "Persetujuan Invoice — AODP" };

interface Row {
  id: string;
  amount: number;
  threshold_amount: number;
  requested_at: string;
  sales_order_id: string;
  order: { order_number: string; customer: { name: string; class: { name: string } | null } | null } | null;
  requester: { full_name: string } | null;
}

export default async function InvoiceApprovalsPage() {
  const user = await getAuthUser();
  if (!hasRole(user.roles, INVOICE_APPROVER_ROLES)) redirect("/dashboard");

  const { data } = await getAdminClient()
    .from("invoice_issue_approvals")
    .select("id, amount, threshold_amount, requested_at, sales_order_id, order:sales_orders!sales_order_id(order_number, customer:customers!customer_id(name, class:customer_classes!class_id(name))), requester:users!requested_by(full_name)")
    .eq("company_id", user.company_id)
    .eq("status", "pending")
    .order("requested_at");
  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
      <PageHeader title="Persetujuan Invoice" subtitle="Invoice bernilai besar menunggu persetujuan Owner sebelum terbit" />
      {rows.length === 0 && <p className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">Tidak ada permintaan yang menunggu.</p>}
      {rows.map((r) => (
        <div key={r.id} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-gray-900">{r.order?.customer?.name ?? "Customer"} · {r.order?.order_number}</p>
            <p className="text-lg font-bold text-gray-900">{formatIDR(Number(r.amount))}</p>
          </div>
          <p className="text-xs text-gray-500">
            Klasifikasi {r.order?.customer?.class?.name ?? "-"} · batas {formatIDR(Number(r.threshold_amount))} · diminta {r.requester?.full_name ?? "-"}
          </p>
          <Link href={`/dashboard/orders/${r.sales_order_id}`} className="text-sm font-medium text-blue-600 underline">Lihat order & bukti pengiriman</Link>
          <InvoiceApprovalActions approvalId={r.id} />
        </div>
      ))}
    </div>
  );
}
