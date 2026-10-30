"use server";

// =============================================================================
// Server action pengantar (web, tanpa Telegram) -- irisan S1: Mulai Antar &
// Sudah Tiba. Pencatatan hasil + bukti menyusul di S2. Tenant & aktor SELALU
// dari sesi (getAuthUser). Hanya pengantar yang ditugaskan yang boleh
// mengerjakan; RPC dispatch_delivery_atomic menegakkan hal yang sama di DB.
// Rancangan: docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { SupabaseDeliveryRepository } from "./repository";
import { buildArrivalLocationEvidence, canOperateDelivery, type GeoFix } from "./web-rules";

export interface DeliveryStepResult {
  ok: boolean;
  error?: string;
}

async function loadOperableDelivery(deliveryId: string) {
  const user = await getAuthUser();
  const repository = new SupabaseDeliveryRepository(getAdminClient());
  const delivery = await repository.getDelivery(deliveryId);
  if (!delivery || delivery.companyId !== user.company_id) {
    return { error: "Pengiriman tidak ditemukan." as const };
  }
  if (!canOperateDelivery(user.id, delivery)) {
    return { error: "Pengiriman ini bukan tugas Anda." as const };
  }
  return { user, repository, delivery };
}

export async function startDeliveryAction(deliveryId: string): Promise<DeliveryStepResult> {
  const ctx = await loadOperableDelivery(deliveryId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, repository, delivery } = ctx;

  if (delivery.status !== "planned") return { ok: true }; // idempoten: sudah berjalan

  const result = await repository.dispatchDeliveryAtomic({
    companyId: user.company_id,
    actorId: user.id,
    deliveryId,
  });
  if (result.outcome === "forbidden" || result.outcome === "not_found") {
    return { ok: false, error: "Tidak bisa memulai pengiriman ini." };
  }
  await repository.syncSalesOrderStatus(delivery.salesOrderId);
  await repository.insertEvent({
    companyId: user.company_id,
    deliveryId,
    eventType: "dispatched",
    fromStatus: "planned",
    toStatus: "dispatched",
    actorId: user.id,
    telegramUpdateEventId: null,
    payload: { source: "web" },
  });

  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/deliveries/${deliveryId}`);
  revalidatePath(`/dashboard/orders/${delivery.salesOrderId}`);
  return { ok: true };
}

export async function arriveDeliveryAction(deliveryId: string, fix: GeoFix | null): Promise<DeliveryStepResult> {
  const ctx = await loadOperableDelivery(deliveryId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, repository, delivery } = ctx;

  if (delivery.status === "arrived") return { ok: true }; // idempoten
  if (delivery.status !== "dispatched") {
    return { ok: false, error: "Mulai antar dulu sebelum menandai sudah tiba." };
  }

  const { evidence, locationMissing } = buildArrivalLocationEvidence(fix, new Date().toISOString());

  await repository.recordArrival(deliveryId);
  if (evidence) await repository.insertEvidence(user.company_id, deliveryId, evidence, user.id);
  await repository.insertEvent({
    companyId: user.company_id,
    deliveryId,
    eventType: "arrived",
    fromStatus: "dispatched",
    toStatus: "arrived",
    actorId: user.id,
    telegramUpdateEventId: null,
    payload: { source: "web", locationMissing },
  });

  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/deliveries/${deliveryId}`);
  revalidatePath(`/dashboard/orders/${delivery.salesOrderId}`);
  return { ok: true };
}
