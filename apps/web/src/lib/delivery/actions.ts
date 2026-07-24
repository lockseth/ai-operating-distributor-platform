"use server";

// =============================================================================
// Server action — membentuk delivery dari confirmed sales order + assign
// driver + kirim tugas pengiriman via Telegram (workflow B.1/B.2).
//
// Tenant SELALU dari sesi (getAuthUser()), tidak pernah dari input form.
// Driver WAJIB sudah terdaftar di telegram_identities — tidak pernah
// mengarang chat_id (sesuai instruksi "jangan menyentuh Telegram identity
// tanpa data asli").
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { SupabaseDeliveryRepository } from "./repository";
import { HttpTelegramSender } from "@/lib/telegram/client";
import { buildDeliveryTaskMessage } from "./confirmation";

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

  const { data: identityRow } = await supabase
    .from("telegram_identities")
    .select("id, telegram_chat_id")
    .eq("user_id", driverId)
    .eq("company_id", user.company_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!identityRow) {
    return {
      ok: false,
      error: "Driver ini belum terdaftar di Telegram (telegram_identities). Daftarkan dulu sebelum assign — lihat dokumentasi.",
    };
  }
  const identity = identityRow as { id: string; telegram_chat_id: number };

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
  await repository.setConversationState(identity.id, user.company_id, {
    pendingDeliveryId: delivery.id,
    awaiting: "start_confirmation",
    currentItemIndex: 0,
    draftState: {},
  });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    const sender = new HttpTelegramSender(botToken);
    await sender.sendMessage(
      identity.telegram_chat_id,
      buildDeliveryTaskMessage(
        { orderNumber: order.orderNumber, customerName: order.customerName },
        order.items.map((i) => ({ productName: i.productName, unit: i.unit, quantity: i.quantity }))
      )
    );
  }

  revalidatePath(`/dashboard/orders/${salesOrderId}`);
  return { ok: true, deliveryId: delivery.id };
}
