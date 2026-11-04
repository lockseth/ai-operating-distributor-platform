import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";
import { canOperateDelivery, nextDeliveryStep } from "@/lib/delivery/web-rules";
import { DeliveryTaskActions } from "@/components/delivery/delivery-task-actions";
import { DeliveryResultWizard } from "@/components/delivery/delivery-result-wizard";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Detail Pengiriman — AODP" };

const STATUS_LABEL: Record<string, string> = {
  planned: "Siap diantar",
  dispatched: "Sedang diantar",
  arrived: "Sudah tiba",
};

export default async function DeliveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "delivery.view")) redirect("/dashboard");

  const admin = getAdminClient();
  const delivery = await new SupabaseDeliveryRepository(admin).getDelivery(id);
  if (!delivery || delivery.companyId !== user.company_id) notFound();

  const canManage = hasPermission(user.permissions, "delivery.manage");
  const mine = canOperateDelivery(user.id, delivery);
  if (!mine && !canManage) notFound();

  const { data: orderRow } = await admin
    .from("sales_orders")
    .select("order_number, customer:customers!customer_id(name, address, phone)")
    .eq("id", delivery.salesOrderId)
    .eq("company_id", user.company_id)
    .maybeSingle();
  const order = orderRow as unknown as { order_number: string; customer: { name: string; address: string | null; phone: string | null } | null } | null;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-2xl">
      <Link href="/dashboard/deliveries" className="text-sm text-blue-600">← Kembali ke Pengiriman</Link>
      <PageHeader title={order?.customer?.name ?? "Pengiriman"} subtitle={`${order?.order_number ?? ""} · ${STATUS_LABEL[delivery.status] ?? delivery.status}`} />

      <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700 shadow-sm">
        {order?.customer?.address && <p>{order.customer.address}</p>}
        {order?.customer?.phone && <p className="mt-1 text-gray-500">Telp: {order.customer.phone}</p>}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <p className="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">Barang yang diantar</p>
        <ul className="divide-y divide-gray-100">
          {delivery.items.map((item) => (
            <li key={item.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span className="text-gray-800">{item.productName}</span>
              <span className="font-semibold text-gray-900">{item.orderedQuantity} {item.unit ?? ""}</span>
            </li>
          ))}
        </ul>
      </div>

      {!mine && canManage && ["planned", "dispatched", "arrived"].includes(delivery.status) ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            Input kantor: isi hasil dari faktur bertanda tangan toko. Foto faktur wajib dan input ini tercatat sebagai
            &quot;Diinput admin&quot;.
          </p>
          <DeliveryResultWizard
            asAdmin
            deliveryId={delivery.id}
            items={delivery.items.map((i) => ({ id: i.id, productName: i.productName, unit: i.unit, dispatchedQuantity: i.dispatchedQuantity }))}
          />
        </div>
      ) : mine ? (
        nextDeliveryStep(delivery.status) === "record_result" ? (
          <DeliveryResultWizard
            deliveryId={delivery.id}
            items={delivery.items.map((i) => ({ id: i.id, productName: i.productName, unit: i.unit, dispatchedQuantity: i.dispatchedQuantity }))}
          />
        ) : (
          <DeliveryTaskActions deliveryId={delivery.id} step={nextDeliveryStep(delivery.status)} />
        )
      ) : (
        <p className="text-xs text-gray-500">Hanya pengantar yang ditugaskan yang dapat mengerjakan pengiriman ini.</p>
      )}
    </div>
  );
}
