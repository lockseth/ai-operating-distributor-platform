"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
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
  // Satu input "tanggal kirim diminta customer" -- diteruskan ke DUA kolom
  // server (delivery_date utk tampilan, requested_delivery_date sbg hard
  // constraint AI Dispatch Planner). Sengaja disatukan di UI/interface ini
  // supaya sales tidak perlu tahu ada 2 konsep berbeda -- lihat TRACKER.md
  // Gate P4.01 untuk histori kenapa awalnya sempat 2 field terpisah.
  delivery_date: string | null;
  notes: string | null;
  discount_amount: number;
  items: OrderItemInput[];
  // Termin pembayaran dalam hari (opsional) -- sales_orders.payment_terms_days,
  // dibaca Document Engine untuk baris "Tempo" di PO/Invoice (Gate P4.02).
  payment_terms_days: number | null;
}

// -----------------------------------------------------------------------
// Generate order number: SO-YYMM-XXXX
//
// WAJIB pakai admin client (bukan createClient() yang kena RLS) --
// sales_orders_select RLS membatasi role sales cuma lihat order miliknya
// sendiri (sales_id = auth.uid()), padahal constraint unique order_number
// company-wide. Sebelumnya pakai client biasa: kalau ada order bulan ini
// dari sales lain yang tidak terlihat sales ini, nomor urut yang
// dihasilkan undercount dan tabrakan dengan order yang sudah ada --
// root cause 500 "duplicate key value violates unique constraint
// sales_orders_company_id_order_number_key", dikonfirmasi lewat Vercel
// logs (digest 790590101) saat role-play UAT 2026-08-16.
// -----------------------------------------------------------------------
async function generateOrderNumber(companyId: string): Promise<string> {
  const supabase = getAdminClient();
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
    p_requested_delivery_date: data.delivery_date || null,
    p_payment_terms_days: data.payment_terms_days ?? null,
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
    case "customer_not_owned":
      throw new Error("Toko ini sudah diatribusikan ke Sales lain — order ditolak.");
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
    p_requested_delivery_date: data.delivery_date || null,
    p_payment_terms_days: data.payment_terms_days ?? null,
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
      throw new Error("Hanya order berstatus Draft yang dapat diedit");
    case "invalid_customer":
      throw new Error("Customer tidak ditemukan");
    case "customer_not_owned":
      throw new Error("Toko ini sudah diatribusikan ke Sales lain — order ditolak.");
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

  // Gate 3E-D4-C4: target "confirmed" WAJIB lewat confirm_sales_order_atomic
  // (satu-satunya RPC yang memvalidasi special-price approval boundary) --
  // update_sales_order_status_atomic sekarang menolak p_new_status='confirmed'
  // tanpa kecuali (migration 20260926000001, Guard G). Tombol "Konfirmasi"
  // di UI tidak berubah -- hanya reroute RPC backend.
  if (newStatus === "confirmed") {
    const admin = getAdminClient();
    const { data: rpcData, error: rpcError } = await admin.rpc("confirm_sales_order_atomic", {
      p_company_id: user.company_id,
      p_actor_id: user.id,
      p_order_id: orderId,
      p_payment_terms_days: null,
    });

    if (rpcError) throw new Error(rpcError.message);
    const row = ((rpcData ?? []) as { result_outcome: string; already_confirmed: boolean }[])[0];
    if (!row) throw new Error("confirm_sales_order_atomic: empty RPC result");

    switch (row.result_outcome) {
      case "confirmed":
      case "already_confirmed":
        break;
      case "forbidden":
        throw new Error("Tidak punya akses");
      case "not_found":
        throw new Error("Order tidak ditemukan");
      case "invalid_order_state":
        throw new Error("Order tidak dapat dikonfirmasi pada status saat ini.");
      case "pending_approval_exists":
        throw new Error("Order masih menunggu keputusan Owner atas proposal harga khusus.");
      case "approval_snapshot_mismatch":
        throw new Error("Order berubah setelah disetujui Owner -- ajukan ulang proposal harga khusus.");
      case "unapproved_special_price":
        throw new Error("Order memakai harga khusus yang belum/tidak disetujui Owner.");
      default:
        throw new Error(`Gagal mengonfirmasi order: ${row.result_outcome}`);
    }

    revalidatePath("/dashboard/orders");
    revalidatePath(`/dashboard/orders/${orderId}`);
    return;
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
