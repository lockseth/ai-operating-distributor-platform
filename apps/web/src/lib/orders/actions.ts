"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";

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

  const supabase    = await createClient();
  const orderNumber = await generateOrderNumber(user.company_id);
  const totals      = calcTotals(data.items, data.discount_amount ?? 0);

  const { data: order, error: orderError } = await supabase
    .from("sales_orders")
    .insert({
      company_id:      user.company_id,
      order_number:    orderNumber,
      customer_id:     data.customer_id,
      sales_id:        data.sales_id || null,
      status:          "draft",
      notes:           data.notes || null,
      delivery_date:   data.delivery_date || null,
      created_by:      user.id,
      ...totals,
    })
    .select("id")
    .single();

  if (orderError) throw new Error(orderError.message);

  const { error: itemsError } = await supabase
    .from("sales_order_items")
    .insert(
      data.items.map((item) => ({
        order_id:        order.id,
        product_id:      item.product_id,
        quantity:        item.quantity,
        unit_price:      item.unit_price,
        discount_amount: item.discount_amount,
        total_amount:    item.total_amount,
        notes:           item.notes || null,
      }))
    );

  if (itemsError) {
    await supabase.from("sales_orders").delete().eq("id", order.id);
    throw new Error(itemsError.message);
  }

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "order.create",
    entity_type: "sales_orders",
    entity_id:   order.id,
    new_data:    { order_number: orderNumber, customer_id: data.customer_id, final_amount: totals.final_amount },
  }).catch(() => {});

  revalidatePath("/dashboard/orders");
  redirect(`/dashboard/orders/${order.id}`);
}

// -----------------------------------------------------------------------
// Update Order (draft/confirmed only)
// -----------------------------------------------------------------------
export async function updateOrderAction(
  orderId: string,
  oldData: { order_number: string; final_amount: number },
  data: OrderFormData
): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "orders.edit")) {
    throw new Error("Tidak punya akses untuk mengedit sales order");
  }
  if (data.items.length === 0) {
    throw new Error("Order harus memiliki minimal 1 item");
  }

  const supabase = await createClient();
  const totals   = calcTotals(data.items, data.discount_amount ?? 0);

  // Verify order status is editable
  const { data: existing } = await supabase
    .from("sales_orders")
    .select("status")
    .eq("id", orderId)
    .eq("company_id", user.company_id)
    .single();

  if (!existing) throw new Error("Order tidak ditemukan");
  if (!["draft", "confirmed"].includes(existing.status)) {
    throw new Error("Hanya order berstatus Draft atau Confirmed yang dapat diedit");
  }

  // Delete existing items and re-insert
  await supabase.from("sales_order_items").delete().eq("order_id", orderId);

  const { error: itemsError } = await supabase
    .from("sales_order_items")
    .insert(
      data.items.map((item) => ({
        order_id:        orderId,
        product_id:      item.product_id,
        quantity:        item.quantity,
        unit_price:      item.unit_price,
        discount_amount: item.discount_amount,
        total_amount:    item.total_amount,
        notes:           item.notes || null,
      }))
    );

  if (itemsError) throw new Error(itemsError.message);

  const { error } = await supabase
    .from("sales_orders")
    .update({
      customer_id:   data.customer_id,
      sales_id:      data.sales_id || null,
      notes:         data.notes || null,
      delivery_date: data.delivery_date || null,
      ...totals,
    })
    .eq("id", orderId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "order.update",
    entity_type: "sales_orders",
    entity_id:   orderId,
    old_data:    oldData as Record<string, unknown>,
    new_data:    { final_amount: totals.final_amount },
  }).catch(() => {});

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
  if (!hasPermission(user.permissions, "orders.edit")) {
    throw new Error("Tidak punya akses");
  }

  const supabase = await createClient();
  const updates: Record<string, unknown> = { status: newStatus };
  if (newStatus === "delivered") updates.delivered_at = new Date().toISOString();

  const { error } = await supabase
    .from("sales_orders")
    .update(updates)
    .eq("id", orderId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "order.status_update",
    entity_type: "sales_orders",
    entity_id:   orderId,
    new_data:    { status: newStatus },
  }).catch(() => {});

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
    hasPermission(user.permissions, "orders.edit");
  if (!canCancel) throw new Error("Tidak punya akses untuk membatalkan order");

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("sales_orders")
    .select("status")
    .eq("id", orderId)
    .eq("company_id", user.company_id)
    .single();

  if (!existing) throw new Error("Order tidak ditemukan");
  if (["delivered", "invoiced", "paid", "cancelled"].includes(existing.status)) {
    throw new Error("Order dengan status ini tidak dapat dibatalkan");
  }

  const { error } = await supabase
    .from("sales_orders")
    .update({ status: "cancelled" })
    .eq("id", orderId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "order.cancel",
    entity_type: "sales_orders",
    entity_id:   orderId,
  }).catch(() => {});

  revalidatePath("/dashboard/orders");
  revalidatePath(`/dashboard/orders/${orderId}`);
}
