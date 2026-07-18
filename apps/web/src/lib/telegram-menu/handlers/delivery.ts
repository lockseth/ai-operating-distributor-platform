// =============================================================================
// Pengiriman Hari Ini -- menu ini murni LAUNCHER. Memilih delivery dari
// daftar menyerahkan kendali percakapan SEPENUHNYA ke
// lib/delivery/workflow.ts (TERKUNCI, tidak diubah) dengan mengisi
// delivery_conversation_state (bukan telegram_menu_conversation_state) ke
// step awal ("start_confirmation") persis seperti jalur trigger langsung --
// pesan tugas pengiriman dirangkai memakai buildDeliveryTaskMessage yang
// SUDAH ADA (lib/delivery/confirmation.ts), tidak ditulis ulang di sini.
// =============================================================================

import type { DeliveryRepositoryInterface } from "@/lib/delivery/repository";
import { buildDeliveryTaskMessage } from "@/lib/delivery/confirmation";
import type { TodayDeliveryRepository } from "@/lib/daily-session/deliveries";
import { parseNumberedChoice, type MenuConversationState } from "../conversation";

export interface DeliveryHandlerDeps {
  todayDeliveryRepository: TodayDeliveryRepository;
  deliveryRepository: Pick<DeliveryRepositoryInterface, "getDelivery" | "getConfirmedOrder" | "setConversationState">;
}

export interface DeliveryHandlerContext {
  companyId: string;
  identityId: string;
  salesmanId: string;
}

export interface DeliveryStepResult {
  message: string;
  nextState: MenuConversationState;
}

export async function startDeliveryFlow(
  ctx: DeliveryHandlerContext,
  deps: DeliveryHandlerDeps,
): Promise<DeliveryStepResult> {
  const deliveries = await deps.todayDeliveryRepository.listTodayDeliveries(ctx.companyId, ctx.salesmanId);
  if (deliveries.length === 0) {
    return {
      message: "Tidak ada pengiriman untuk hari ini.",
      nextState: { awaiting: "none", draft: {} },
    };
  }

  const lines = ["Pilih pengiriman:"];
  deliveries.forEach((d, i) => {
    lines.push(`${i + 1}. ${d.orderNumber} -- ${d.customerName ?? "(toko)"} [${d.status}]`);
  });

  return {
    message: lines.join("\n"),
    nextState: {
      awaiting: "delivery_select",
      draft: { deliveryOptions: deliveries.map((d) => ({ id: d.deliveryId, salesOrderId: d.salesOrderId })) },
    },
  };
}

export async function handleDeliverySelect(
  text: string,
  state: MenuConversationState,
  ctx: DeliveryHandlerContext,
  deps: DeliveryHandlerDeps,
): Promise<DeliveryStepResult> {
  const options = (state.draft.deliveryOptions ?? []) as { id: string; salesOrderId: string }[];
  const choice = parseNumberedChoice(text, options.length);
  if (!choice) {
    return { message: "Pilihan tidak valid. Balas dengan nomor pengiriman.", nextState: state };
  }
  const selected = options[choice - 1]!;

  const delivery = await deps.deliveryRepository.getDelivery(selected.id);
  if (!delivery) {
    return { message: "Pengiriman tidak ditemukan.", nextState: { awaiting: "none", draft: {} } };
  }
  const order = await deps.deliveryRepository.getConfirmedOrder(selected.salesOrderId, ctx.companyId);
  if (!order) {
    return { message: "Order untuk pengiriman ini tidak ditemukan.", nextState: { awaiting: "none", draft: {} } };
  }

  const message = buildDeliveryTaskMessage(
    { orderNumber: order.orderNumber, customerName: order.customerName },
    delivery.items.map((item) => ({
      productName: item.productName,
      unit: item.unit,
      quantity: item.orderedQuantity,
    })),
  );

  // Serahkan ke delivery_conversation_state -- pesan berikutnya dari
  // identity ini ditangani lib/delivery/workflow.ts, bukan menu router.
  await deps.deliveryRepository.setConversationState(ctx.identityId, ctx.companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "start_confirmation",
    currentItemIndex: 0,
    draftState: {},
  });

  return { message, nextState: { awaiting: "none", draft: {} } };
}
