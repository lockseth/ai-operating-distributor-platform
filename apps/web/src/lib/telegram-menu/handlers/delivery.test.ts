import { describe, expect, it } from "vitest";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";
import { InMemoryTodayDeliveryRepository } from "@/lib/daily-session/deliveries";
import type { MenuConversationState } from "../conversation";
import { handleDeliverySelect, startDeliveryFlow, type DeliveryHandlerContext, type DeliveryHandlerDeps } from "./delivery";

const COMPANY = "waluyo";
const SALES_1 = "sales-1";
const IDENTITY_ID = "identity-1";

async function buildDeps(): Promise<{
  deps: DeliveryHandlerDeps;
  deliveryId: string;
  deliveryRepository: InMemoryDeliveryRepository;
}> {
  const deliveryRepository = new InMemoryDeliveryRepository();
  deliveryRepository.seedConfirmedOrder({
    id: "order-1",
    companyId: COMPANY,
    orderNumber: "SO-0001",
    customerName: "Toko Sari",
    status: "confirmed",
    items: [{ id: "item-1", quantity: 10, unit: "dus", unitPrice: 50000, productName: "Indomie Goreng" }],
  });
  const delivery = await deliveryRepository.createDelivery({
    companyId: COMPANY,
    actorId: "owner-1",
    salesOrderId: "order-1",
    idempotencyKey: null,
    driverId: SALES_1,
    items: [{ salesOrderItemId: "item-1", productName: "Indomie Goreng", unit: "dus", unitPrice: 50000, orderedQuantity: 10 }],
  });

  const todayDeliveryRepository = new InMemoryTodayDeliveryRepository();
  todayDeliveryRepository.seedDelivery({
    id: delivery.id,
    companyId: COMPANY,
    salesOrderId: "order-1",
    assignedDriverId: SALES_1,
    status: "planned",
    orderNumber: "SO-0001",
    customerName: "Toko Sari",
  });

  return { deps: { todayDeliveryRepository, deliveryRepository }, deliveryId: delivery.id, deliveryRepository };
}

function ctx(): DeliveryHandlerContext {
  return { companyId: COMPANY, identityId: IDENTITY_ID, salesmanId: SALES_1 };
}

describe("Pengiriman Hari Ini -- 19, 20 (delivery assignment & handoff ke Delivery Verification existing)", () => {
  it("19. startDeliveryFlow menampilkan delivery yang benar-benar ditugaskan", async () => {
    const { deps } = await buildDeps();
    const result = await startDeliveryFlow(ctx(), deps);
    expect(result.message).toContain("SO-0001");
    expect(result.message).toContain("Toko Sari");
    expect(result.nextState.awaiting).toBe("delivery_select");
  });

  it("tanpa delivery -> empty state jujur", async () => {
    const deps: DeliveryHandlerDeps = {
      todayDeliveryRepository: new InMemoryTodayDeliveryRepository(),
      deliveryRepository: new InMemoryDeliveryRepository(),
    };
    const result = await startDeliveryFlow(ctx(), deps);
    expect(result.message).toContain("Tidak ada pengiriman");
    expect(result.nextState.awaiting).toBe("none");
  });

  it("20. Memilih delivery menyerahkan kendali ke delivery_conversation_state (start_confirmation) TANPA mengubah lib/delivery/*", async () => {
    const { deps, deliveryId, deliveryRepository } = await buildDeps();
    const started = await startDeliveryFlow(ctx(), deps);
    const result = await handleDeliverySelect("1", started.nextState, ctx(), deps);

    expect(result.message).toContain("MULAI KIRIM");
    expect(result.message).toContain("Indomie Goreng");
    expect(result.nextState.awaiting).toBe("none"); // menu state dilepas

    const deliveryConvo = await deliveryRepository.getConversationState(IDENTITY_ID);
    expect(deliveryConvo.awaiting).toBe("start_confirmation");
    expect(deliveryConvo.pendingDeliveryId).toBe(deliveryId);
  });

  it("pilihan nomor di luar rentang -> ditolak, state tidak berubah", async () => {
    const { deps } = await buildDeps();
    const started = await startDeliveryFlow(ctx(), deps);
    const result = await handleDeliverySelect("9", started.nextState, ctx(), deps);
    expect(result.message).toContain("tidak valid");
    expect(result.nextState.awaiting).toBe("delivery_select");
  });

  it("draft kosong (state basi) -> pesan tidak valid, tidak melempar error", async () => {
    const { deps } = await buildDeps();
    const emptyState: MenuConversationState = { awaiting: "delivery_select", draft: {} };
    const result = await handleDeliverySelect("1", emptyState, ctx(), deps);
    expect(result.message).toContain("tidak valid");
  });
});
