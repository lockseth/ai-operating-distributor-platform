import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { INVOICE_APPROVER_ROLES } from "@/lib/finance/invoice-approval";
import { AUDIT_REASON_LABEL, type AuditReason } from "@/lib/delivery/audit-sampling";
import { PageHeader } from "@/components/ui/page-header";
import { AuditResultForm, CreateAuditSampleButton } from "@/components/delivery/delivery-audit-controls";

export const metadata = { title: "Audit Pengiriman — AODP" };

interface AuditRow {
  id: string;
  selection_reason: AuditReason;
  status: "pending" | "verified_ok" | "discrepancy";
  selected_at: string;
  checked_at: string | null;
  result_note: string | null;
  sales_order_id: string;
  delivery: { status: string; items: { dispatched_quantity: number; received_quantity: number }[] } | null;
  order: { order_number: string; customer: { name: string; phone: string | null } | null } | null;
}

const STATUS_LABEL = { pending: "Menunggu telepon", verified_ok: "Sesuai", discrepancy: "Tidak sesuai" } as const;
const STATUS_COLOR = { pending: "bg-amber-100 text-amber-800", verified_ok: "bg-green-100 text-green-700", discrepancy: "bg-red-100 text-red-700" } as const;

export default async function DeliveryAuditsPage() {
  const user = await getAuthUser();
  if (!hasRole(user.roles, INVOICE_APPROVER_ROLES)) redirect("/dashboard");

  const { data } = await getAdminClient()
    .from("delivery_audits")
    .select("id, selection_reason, status, selected_at, checked_at, result_note, sales_order_id, delivery:deliveries!delivery_id(status, items:delivery_items(dispatched_quantity, received_quantity)), order:sales_orders!sales_order_id(order_number, customer:customers!customer_id(name, phone))")
    .eq("company_id", user.company_id)
    .order("selected_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as unknown as AuditRow[];
  const pending = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
      <PageHeader title="Audit Pengiriman" subtitle="Telepon toko untuk memastikan barang benar diterima — saksi dari luar admin dan sales" />
      <CreateAuditSampleButton />

      <h2 className="text-sm font-semibold text-gray-900">Perlu dicek ({pending.length})</h2>
      {pending.length === 0 && <p className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">Tidak ada audit yang menunggu.</p>}
      {pending.map((r) => {
        const received = r.delivery?.items.reduce((s, i) => s + Number(i.received_quantity), 0) ?? 0;
        const dispatched = r.delivery?.items.reduce((s, i) => s + Number(i.dispatched_quantity), 0) ?? 0;
        return (
          <div key={r.id} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-gray-900">{r.order?.customer?.name ?? "Customer"} · {r.order?.order_number}</p>
              <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">{AUDIT_REASON_LABEL[r.selection_reason]}</span>
            </div>
            <p className="text-sm text-gray-700">
              Telepon: {r.order?.customer?.phone ? <a href={`tel:${r.order.customer.phone}`} className="font-medium text-blue-600 underline">{r.order.customer.phone}</a> : "nomor belum ada"}
              {" · "}Diterima {received} dari {dispatched} dikirim
            </p>
            <Link href={`/dashboard/orders/${r.sales_order_id}`} className="text-sm font-medium text-blue-600 underline">Lihat order & bukti pengiriman</Link>
            <AuditResultForm auditId={r.id} />
          </div>
        );
      })}

      {done.length > 0 && <h2 className="pt-2 text-sm font-semibold text-gray-900">Riwayat</h2>}
      {done.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white p-3 text-sm">
          <span className="text-gray-900">{r.order?.customer?.name} · {r.order?.order_number}</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span>
          {r.result_note && <p className="w-full text-xs text-gray-500">{r.result_note}</p>}
        </div>
      ))}
    </div>
  );
}
