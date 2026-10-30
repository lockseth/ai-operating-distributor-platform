"use server";

// =============================================================================
// Server action — membentuk delivery dari confirmed sales order + assign
// pengantar. Sejak keputusan Founder 2026-10-30 (web + WhatsApp, tanpa
// Telegram) pengantar TIDAK lagi wajib terdaftar di Telegram: tugas muncul di
// menu Pengiriman (lib/delivery/web-actions.ts). Notifikasi WhatsApp menyusul.
//
// Tenant SELALU dari sesi (getAuthUser()), tidak pernah dari input form.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { SupabaseDeliveryRepository } from "./repository";

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

export interface CreateDeliveryResult {
  ok: boolean;
  error?: string;
  deliveryId?: string;
}

export async function createDeliveryAction(salesOrderId: string, driverId: string): Promise<CreateDeliveryResult> {
  const user = await getAuthUser();
  if (!MANAGE_ROLES.some((r) => user.roles.includes(r))) {
    return { ok: false, error: "Tidak berwenang membuat delivery." };
  }
  if (!salesOrderId || !driverId) {
    return { ok: false, error: "Order dan driver wajib dipilih." };
  }

  const supabase = getAdminClient();
  const repository = new SupabaseDeliveryRepository(supabase);

  const order = await repository.getConfirmedOrder(salesOrderId, user.company_id);
  if (!order) return { ok: false, error: "Order tidak ditemukan." };
  if (order.status !== "confirmed") {
    return { ok: false, error: "Order harus berstatus confirmed sebelum delivery dapat dibuat." };
  }

  const idempotencyKey = `order:${salesOrderId}`;
  const existing = await repository.findDeliveryByIdempotencyKey(user.company_id, idempotencyKey);
  if (existing) return { ok: false, error: "Delivery untuk order ini sudah pernah dibuat.", deliveryId: existing.id };

  const delivery = await repository.createDelivery({
    companyId: user.company_id,
    actorId: user.id,
    salesOrderId,
    idempotencyKey,
    driverId,
    items: order.items.map((i) => ({
      salesOrderItemId: i.id,
      productName: i.productName,
      unit: i.unit,
      unitPrice: i.unitPrice,
      orderedQuantity: i.quantity,
    })),
  });

  await repository.insertEvent({
    companyId: user.company_id,
    deliveryId: delivery.id,
    eventType: "created",
    fromStatus: null,
    toStatus: "planned",
    actorId: user.id,
    telegramUpdateEventId: null,
    payload: { driverId },
  });
  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/orders/${salesOrderId}`);
  return { ok: true, deliveryId: delivery.id };
}
