import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { CancelButton } from "@/components/orders/cancel-button";
import { StatusUpdater } from "@/components/orders/status-updater";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { AssignDriverForm } from "@/components/delivery/assign-driver-form";
import { DeliveryPanel } from "@/components/delivery/delivery-panel";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";
import { computeInvoiceEligibility } from "@/lib/delivery/service";
import { getAdminClient } from "@/lib/supabase/admin";
import type { OrderStatus } from "@/lib/orders/actions";
import { ORDER_SOURCE_LABEL, type OrderSource } from "@/lib/sales-orders/order-source";
import { DisputeReviewPanel, type DisputeRequestView } from "@/components/order-disputes/dispute-review-panel";
import type { ContactSource, OrderStage, Resolution } from "@/lib/order-disputes/types";
import {
  ChevronLeft, Edit2, Plus, ShoppingCart, User, Calendar,
  Package, FileText,
} from "lucide-react";

export const metadata = { title: "Detail Order — AODP" };

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}
function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface OrderItem {
  id: string;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  total_amount: number;
  notes: string | null;
  product_name_raw: string | null;
  product: { name: string; sku: string; unit: string } | null;
}

interface Order {
  id: string;
  order_number: string;
  status: string;
  total_amount: number;
  discount_amount: number;
  tax_amount: number;
  final_amount: number;
  notes: string | null;
  delivery_date: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  source_channel: string | null;
  order_source: string | null;
  customer_name_raw: string | null;
  requires_discount_review: boolean | null;
  customer: { id: string; name: string; code: string; phone: string | null; area: string | null } | null;
  sales:    { full_name: string } | null;
  creator:  { full_name: string } | null;
  items:    OrderItem[];
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "orders.view")) redirect("/dashboard/orders");

  const supabase = await createClient();

  const { data } = await supabase
    .from("sales_orders")
    .select(`
      *,
      customer:customers!customer_id(id, name, code, phone, area),
      sales:users!sales_id(full_name),
      creator:users!created_by(full_name),
      items:sales_order_items(id, quantity, unit_price, discount_amount, total_amount, notes, product_name_raw, product:products!product_id(name, sku, unit))
    `)
    .eq("id", id)
    .eq("company_id", user.company_id)
    .single();

  if (!data) notFound();

  const order      = data as unknown as Order;
  const canCreate  = hasPermission(user.permissions, "orders.create");
  const canEdit    = hasPermission(user.permissions, "orders.update");
  const canCancel  = hasPermission(user.permissions, "orders.delete") || canEdit;
  const isEditable = ["draft", "confirmed"].includes(order.status);
  const isCancellable = !["delivered", "invoiced", "paid", "cancelled"].includes(order.status);

  // --- Delivery Verification (tahap 2 vertical slice) ---
  const canManageDelivery = hasPermission(user.permissions, "delivery.manage");
  const deliveryRepository = new SupabaseDeliveryRepository(supabase);
  const delivery = await deliveryRepository.getLatestDeliveryForOrder(order.id);

  let deliveryEvents: { eventType: string; toStatus: string | null; createdAt: string }[] = [];
  let ownerAlertStatus: "pending" | "sent" | "failed" | null = null;
  if (delivery) {
    const { data: eventRows } = await supabase
      .from("delivery_events")
      .select("event_type, to_status, created_at")
      .eq("delivery_id", delivery.id)
      .order("created_at", { ascending: true });
    deliveryEvents = ((eventRows ?? []) as { event_type: string; to_status: string | null; created_at: string }[]).map((e) => ({
      eventType: e.event_type,
      toStatus: e.to_status,
      createdAt: e.created_at,
    }));

    const { data: alertRow } = await supabase
      .from("owner_alerts")
      .select("status")
      .eq("delivery_id", delivery.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    ownerAlertStatus = (alertRow as { status: "pending" | "sent" | "failed" } | null)?.status ?? null;
  }

  // --- Order Cancellation & Dispute Human Review (purely additive) ---
  const canReviewDisputes = hasPermission(user.permissions, "orders.cancellation_review");
  const { data: disputeRows } = await supabase
    .from("order_cancellation_disputes")
    .select(`
      id, request_type, reason_code, notes, reported_pic_name_snapshot, contact_source,
      order_stage_at_request, ai_classification, status, resolution, resolution_notes,
      actual_pic_name_snapshot, requested_by, requested_at, reviewed_by, reviewed_at,
      requested_by_user:users!requested_by(full_name),
      reviewed_by_user:users!reviewed_by(full_name)
    `)
    .eq("company_id", user.company_id)
    .eq("sales_order_id", order.id)
    .order("requested_at", { ascending: false });

  const disputeRequests: DisputeRequestView[] = ((disputeRows ?? []) as unknown as {
    id: string;
    request_type: "CUSTOMER_CANCELLED" | "CUSTOMER_DENIES_ORDER";
    reason_code: string;
    notes: string | null;
    reported_pic_name_snapshot: string | null;
    contact_source: ContactSource;
    order_stage_at_request: OrderStage;
    ai_classification: string | null;
    status: DisputeRequestView["status"];
    resolution: Resolution | null;
    resolution_notes: string | null;
    actual_pic_name_snapshot: string | null;
    requested_by: string;
    requested_at: string;
    reviewed_by: string | null;
    reviewed_at: string | null;
    requested_by_user: { full_name: string } | null;
    reviewed_by_user: { full_name: string } | null;
  }[]).map((r) => ({
    id: r.id,
    requestType: r.request_type,
    reasonCode: r.reason_code,
    notes: r.notes,
    reportedPicName: r.reported_pic_name_snapshot,
    contactSource: r.contact_source,
    orderStageAtRequest: r.order_stage_at_request,
    aiClassification: r.ai_classification,
    status: r.status,
    resolution: r.resolution,
    resolutionNotes: r.resolution_notes,
    actualPicName: r.actual_pic_name_snapshot,
    requestedByName: r.requested_by_user?.full_name ?? "—",
    requestedById: r.requested_by,
    requestedAt: r.requested_at,
    reviewedByName: r.reviewed_by_user?.full_name ?? null,
    reviewedAt: r.reviewed_at,
  }));

  let availableDrivers: { id: string; full_name: string }[] = [];
  if (!delivery && order.status === "confirmed" && canManageDelivery) {
    const admin = getAdminClient();
    const { data: driverRows } = await admin
      .from("user_roles")
      .select("user:users!user_id(id, full_name), role:roles!role_id(name)")
      .eq("company_id", user.company_id);
    availableDrivers = ((driverRows ?? []) as unknown as { user: { id: string; full_name: string } | null; role: { name: string } | null }[])
      .filter((r) => r.role?.name === "driver" && r.user)
      .map((r) => ({ id: r.user!.id, full_name: r.user!.full_name }));
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Breadcrumb + Actions */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Link href="/dashboard/orders" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Sales Order
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && <StatusUpdater orderId={order.id} currentStatus={order.status as OrderStatus} />}
          {canCreate && (
            <Link
              href="/dashboard/orders/new"
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              Tambah Order
            </Link>
          )}
          {canCancel && isCancellable && <CancelButton orderId={order.id} />}
          {canEdit && isEditable && (
            <Link href={`/dashboard/orders/${order.id}/edit`}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              <Edit2 className="h-4 w-4" />
              Edit Order
            </Link>
          )}
        </div>
      </div>

      {/* Header */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 shrink-0">
              <ShoppingCart className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-xl font-bold font-mono text-gray-900">{order.order_number}</h1>
                <OrderStatusBadge status={order.status} />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
                {order.customer ? (
                  <Link href={`/dashboard/customers/${order.customer.id}`}
                    className="flex items-center gap-1 hover:text-blue-600">
                    <User className="h-3.5 w-3.5" />
                    {order.customer.name}
                  </Link>
                ) : order.customer_name_raw ? (
                  <span className="flex items-center gap-1 text-amber-600" title="Belum ter-match ke master pelanggan">
                    <User className="h-3.5 w-3.5" />
                    {order.customer_name_raw} (belum ter-match)
                  </span>
                ) : null}
                {order.source_channel === "telegram" && (
                  <>
                    <span>·</span>
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                      via Telegram
                    </span>
                  </>
                )}
                {order.order_source && (
                  <>
                    <span>·</span>
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                      {ORDER_SOURCE_LABEL[order.order_source as OrderSource] ?? order.order_source}
                    </span>
                  </>
                )}
                {order.requires_discount_review && (
                  <>
                    <span>·</span>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      ⚠️ Butuh review diskon
                    </span>
                  </>
                )}
                {order.sales && (
                  <>
                    <span>·</span>
                    <span>Sales: {order.sales.full_name}</span>
                  </>
                )}
                {order.delivery_date && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" />
                      Kirim: {formatDate(order.delivery_date)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Subtotal</p>
          <p className="text-base font-bold text-gray-900">{formatIDR(order.total_amount)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Diskon</p>
          <p className="text-base font-bold text-gray-900">{formatIDR(order.discount_amount)}</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">PPN 11%</p>
          <p className="text-base font-bold text-gray-900">{formatIDR(order.tax_amount)}</p>
        </div>
        <div className="rounded-xl border bg-blue-50 p-4 shadow-sm">
          <p className="text-xs text-blue-600 mb-1">Total Tagihan</p>
          <p className="text-base font-bold text-blue-700">{formatIDR(order.final_amount)}</p>
        </div>
      </div>

      {/* Items table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <Package className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Item Produk</h2>
          <span className="ml-auto text-xs text-gray-400">{order.items.length} item</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-5 py-3 text-left text-xs font-medium text-gray-500">Produk</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Qty</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Harga Satuan</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Diskon</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="px-5 py-3">
                  <p className="font-medium text-gray-900">
                    {item.product?.name ?? item.product_name_raw ?? "—"}
                  </p>
                  {item.product?.sku && <p className="text-xs text-gray-400 font-mono">{item.product.sku}</p>}
                  {!item.product && item.product_name_raw && (
                    <p className="text-xs text-amber-600">belum ter-match ke master produk</p>
                  )}
                  {item.notes && <p className="text-xs text-gray-500 mt-0.5 italic">{item.notes}</p>}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {item.quantity.toLocaleString("id-ID")} {item.product?.unit}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{formatIDR(item.unit_price)}</td>
                <td className="px-4 py-3 text-right text-gray-500">
                  {item.discount_amount > 0 ? formatIDR(item.discount_amount) : "—"}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">{formatIDR(item.total_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Delivery Verification */}
      {delivery ? (
        <DeliveryPanel
          status={delivery.status}
          attemptNumber={delivery.attemptNumber}
          items={delivery.items}
          exceptions={delivery.exceptions}
          evidence={delivery.evidence}
          recipient={delivery.recipient}
          events={deliveryEvents}
          invoiceEligibility={computeInvoiceEligibility(delivery)}
          ownerAlertStatus={ownerAlertStatus}
        />
      ) : (
        order.status === "confirmed" && canManageDelivery && (
          <AssignDriverForm salesOrderId={order.id} drivers={availableDrivers} />
        )
      )}

      {/* Order Cancellation & Dispute — Human Review */}
      <DisputeReviewPanel
        requests={disputeRequests}
        salesOrderId={order.id}
        canReview={canReviewDisputes}
        currentUserId={user.id}
      />

      {/* Notes */}
      {order.notes && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex items-start gap-2">
            <FileText className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs text-gray-500 mb-1">Catatan</p>
              <p className="text-sm text-gray-700 whitespace-pre-line">{order.notes}</p>
            </div>
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="rounded-xl border bg-gray-50 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>Dibuat: {formatDateTime(order.created_at)}</span>
          {order.creator?.full_name && <span>oleh {order.creator.full_name}</span>}
          {order.delivered_at && <span>Terkirim: {formatDateTime(order.delivered_at)}</span>}
          <span>Terakhir diubah: {formatDateTime(order.updated_at)}</span>
          <span className="font-mono">ID: {order.id}</span>
        </div>
      </div>
    </div>
  );
}
