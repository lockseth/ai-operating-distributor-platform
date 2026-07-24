"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { getAdminClient } from "@/lib/supabase/admin";

export type OrderStatus =
  | "draft" | "confirmed" | "processing"
  | "delivering" | "delivered" | "invoiced" | "paid" | "cancelled";

export interface OrderItemInput {
  product_id: string;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  total_amount: number;
  notes: string | null;
}

export interface OrderFormData {
  customer_id: string;
  sales_id: string | null;
  delivery_date: string | null;
  notes: string | null;
  discount_amount: number;
  items: OrderItemInput[];
}

// -----------------------------------------------------------------------
// Generate order number: SO-YYMM-XXXX
// -----------------------------------------------------------------------
async function generateOrderNumber(companyId: string): Promise<string> {
  const supabase = await createClient();
  const now      = new Date();
  const yy       = String(now.getFullYear()).slice(2);
  const mm       = String(now.getMonth() + 1).padStart(2, "0");
  const prefix   = `SO-${yy}${mm}-`;

  const { data } = await supabase
    .from("sales_orders")
    .select("order_number")
    .eq("company_id", companyId)
    .like("order_number", `${prefix}%`)
    .order("order_number", { ascending: false })
    .limit(1);

  const lastSeq = data?.[0]?.order_number?.replace(prefix, "") ?? "0000";
  const nextSeq = String(parseInt(lastSeq, 10) + 1).padStart(4, "0");
  return `${prefix}${nextSeq}`;
}

// -----------------------------------------------------------------------
// Calculate totals
// -----------------------------------------------------------------------
function calcTotals(items: OrderItemInput[], orderDiscount: number) {
  const total_amount    = items.reduce((s, i) => s + i.total_amount, 0);
  const discount_amount = orderDiscount;
  const tax_amount      = Math.round((total_amount - discount_amount) * 0.11);
  const final_amount    = total_amount - discount_amount + tax_amount;
  return { total_amount, discount_amount, tax_amount, final_amount };
}

// -----------------------------------------------------------------------
// Create Order
// -----------------------------------------------------------------------
export async function createOrderAction(data: OrderFormData): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "orders.create")) {
    throw new Error("Tidak punya akses untuk membuat sales order");
  }
  if (data.items.length === 0) {
    throw new Error("Order harus memiliki minimal 1 item");
  }

  const orderNumber = await generateOrderNumber(user.company_id);
  const admin = getAdminClient();

  const { data: rpcData, error: rpcError } = await admin.rpc("create_sales_order_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_order_number: orderNumber,
    p_customer_id: data.customer_id,
    p_sales_id: data.sales_id || null,
    p_notes: data.notes || null,
    p_delivery_date: data.delivery_date || null,
    p_discount_amount: data.discount_amount ?? 0,
    p_items: data.items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: item.discount_amount,
      total_amount: item.total_amount,
      notes: item.notes || null,
    })),
  });

  if (rpcError) throw new Error(rpcError.message);
  const row = ((rpcData ?? []) as { result_outcome: string; result_order_id: string }[])[0];
  if (!row) throw new Error("create_sales_order_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "created":
      break;
    case "forbidden":
      throw new Error("Tidak punya akses untuk membuat sales order");
    case "invalid_customer":
      throw new Error("Customer tidak ditemukan");
    case "invalid_sales_id":
      throw new Error("Salesperson tidak valid");
    case "invalid_product":
      throw new Error("Salah satu produk tidak valid");
    case "no_items":
      throw new Error("Order harus memiliki minimal 1 item");
    default:
      throw new Error(`Gagal membuat order: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/orders");
  redirect(`/dashboard/orders/${row.result_order_id}`);
}

// -----------------------------------------------------------------------
// Update Order (draft/confirmed only)
// -----------------------------------------------------------------------
export async function updateOrderAction(
  orderId: string,
  _oldData: { order_number: string; final_amount: number },
  data: OrderFormData
): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "orders.update")) {
    throw new Error("Tidak punya akses untuk mengedit sales order");
  }
  if (data.items.length === 0) {
    throw new Error("Order harus memiliki minimal 1 item");
  }

  const admin = getAdminClient();
  const { data: rpcData, error: rpcError } = await admin.rpc("update_sales_order_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_order_id: orderId,
    p_customer_id: data.customer_id,
    p_sales_id: data.sales_id || null,
    p_notes: data.notes || null,
    p_delivery_date: data.delivery_date || null,
    p_discount_amount: data.discount_amount ?? 0,
    p_items: data.items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      discount_amount: item.discount_amount,
      total_amount: item.total_amount,
      notes: item.notes || null,
    })),
  });

  if (rpcError) throw new Error(rpcError.message);
  const row = ((rpcData ?? []) as { result_outcome: string }[])[0];
  if (!row) throw new Error("update_sales_order_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "updated":
      break;
    case "forbidden":
      throw new Error("Tidak punya akses untuk mengedit sales order");
    case "not_found":
      throw new Error("Order tidak ditemukan");
    case "invalid_status":
      throw new Error("Hanya order berstatus Draft atau Confirmed yang dapat diedit");
    case "invalid_customer":
      throw new Error("Customer tidak ditemukan");
    case "invalid_sales_id":
      throw new Error("Salesperson tidak valid");
    case "invalid_product":
      throw new Error("Salah satu produk tidak valid");
    case "no_items":
      throw new Error("Order harus memiliki minimal 1 item");
    default:
      throw new Error(`Gagal mengubah order: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/orders");
  revalidatePath(`/dashboard/orders/${orderId}`);
  redirect(`/dashboard/orders/${orderId}`);
}

// -----------------------------------------------------------------------
// Update Status
// -----------------------------------------------------------------------
export async function updateOrderStatusAction(
  orderId: string,
  newStatus: OrderStatus
): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "orders.update")) {
    throw new Error("Tidak punya akses");
  }
  // Defense-in-depth: enforcement utama ada di RPC (guard di database, lihat
  // migration 20260824000001 & 20260825000001). Tidak ada role -- termasuk
  // owner -- yang bisa melewati ini lewat action generik; status paid hanya
  // lewat payment workflow terverifikasi, status invoiced hanya lewat jalur
  // issuance canonical (keduanya belum ada, gate mendatang).
  if (newStatus === "paid") {
    throw new Error(
      "Status paid hanya dapat diubah melalui payment workflow terverifikasi, belum tersedia di aplikasi ini."
    );
  }
  if (newStatus === "invoiced") {
    throw new Error(
      "Status invoiced hanya dapat diubah melalui jalur issuance invoice canonical, belum tersedia di aplikasi ini."
    );
  }

  const admin = getAdminClient();
  const { data: rpcData, error: rpcError } = await admin.rpc("update_sales_order_status_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_order_id: orderId,
    p_new_status: newStatus,
  });

  if (rpcError) throw new Error(rpcError.message);
  const row = ((rpcData ?? []) as { result_outcome: string }[])[0];
  if (!row) throw new Error("update_sales_order_status_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "updated":
    case "unchanged":
      break;
    case "forbidden":
      throw new Error("Tidak punya akses");
    case "not_found":
      throw new Error("Order tidak ditemukan");
    case "paid_locked":
      throw new Error("Order ini sudah berstatus paid dan tidak dapat diubah lewat aksi ini.");
    case "payment_workflow_required":
      throw new Error(
        "Status paid hanya dapat diubah melalui payment workflow terverifikasi, belum tersedia di aplikasi ini."
      );
    case "invoiced_locked":
      throw new Error("Order ini sudah berstatus invoiced dan tidak dapat diubah lewat aksi ini.");
    case "invoice_issuance_required":
      throw new Error(
        "Status invoiced hanya dapat diubah melalui jalur issuance invoice canonical, belum tersedia di aplikasi ini."
      );
    default:
      throw new Error(`Gagal mengubah status order: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/orders");
  revalidatePath(`/dashboard/orders/${orderId}`);
}

// -----------------------------------------------------------------------
// Cancel Order
// -----------------------------------------------------------------------
export async function cancelOrderAction(orderId: string): Promise<void> {
  const user = await getAuthUser();
  const canCancel =
    hasPermission(user.permissions, "orders.delete") ||
    hasPermission(user.permissions, "orders.update");
  if (!canCancel) throw new Error("Tidak punya akses untuk membatalkan order");

  const admin = getAdminClient();
  const { data: rpcData, error: rpcError } = await admin.rpc("cancel_sales_order_atomic", {
    p_company_id: user.company_id,
    p_actor_id: user.id,
    p_order_id: orderId,
  });

  if (rpcError) throw new Error(rpcError.message);
  const row = ((rpcData ?? []) as { result_outcome: string }[])[0];
  if (!row) throw new Error("cancel_sales_order_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "cancelled":
      break;
    case "forbidden":
      throw new Error("Tidak punya akses untuk membatalkan order");
    case "not_found":
      throw new Error("Order tidak ditemukan");
    case "invalid_status":
      throw new Error("Order dengan status ini tidak dapat dibatalkan");
    default:
      throw new Error(`Gagal membatalkan order: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/orders");
  revalidatePath(`/dashboard/orders/${orderId}`);
}
