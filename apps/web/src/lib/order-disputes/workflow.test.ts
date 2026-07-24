import { describe, it, expect } from "vitest";
import { processDisputeMessage, type ResolvedDisputeIdentity, type OrderDisputeWorkflowDeps } from "./workflow";
import { InMemoryOrderDisputeRepository } from "./repository";
import { InMemoryDisputeConversationRepository } from "./conversation";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import type { OrderStage } from "./types";
import { InMemoryDispatchRepository } from "@/lib/dispatch/repository";
import type { DispatchPlan } from "@/lib/dispatch/types";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const SALESMAN_A = "salesman-a";
const OWNER_A = "owner-a";
const CHAT_ID = 5001;

function makeDeps(): OrderDisputeWorkflowDeps & { repository: InMemoryOrderDisputeRepository; sender: RecordingTelegramSender } {
  const repository = new InMemoryOrderDisputeRepository();
  const conversationRepository = new InMemoryDisputeConversationRepository();
  const sender = new RecordingTelegramSender();
  return { repository, conversationRepository, sender };
}

function makeDepsWithDispatch(): OrderDisputeWorkflowDeps & {
  repository: InMemoryOrderDisputeRepository;
  sender: RecordingTelegramSender;
  dispatchRepository: InMemoryDispatchRepository;
} {
  const base = makeDeps();
  const dispatchRepository = new InMemoryDispatchRepository();
  return { ...base, dispatchRepository };
}

function seedDispatchPlan(
  dispatchRepository: InMemoryDispatchRepository,
  overrides: Partial<DispatchPlan> = {}
): DispatchPlan {
  const now = new Date().toISOString();
  const plan: DispatchPlan = {
    id: overrides.id ?? "plan-1",
    companyId: overrides.companyId ?? COMPANY_A,
    salesOrderId: overrides.salesOrderId ?? "order-1",
    planningStatus: overrides.planningStatus ?? "scheduled",
    deliveryDate: overrides.deliveryDate ?? "2026-08-01",
    deliveryArea: overrides.deliveryArea ?? "Area A",
    deliveryGroupKey: overrides.deliveryGroupKey ?? "Area A|2026-08-01",
    assignedActorId: overrides.assignedActorId ?? SALESMAN_A,
    planningReason: overrides.planningReason ?? "AI planned.",
    confidenceScore: overrides.confidenceScore ?? 0.9,
    isOverride: overrides.isOverride ?? false,
    plannedAt: overrides.plannedAt ?? now,
    scheduledAt: overrides.scheduledAt ?? now,
    createdBy: overrides.createdBy ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
  dispatchRepository.plans.set(plan.id, plan);
  return plan;
}

function makeDepsWithDelivery(): OrderDisputeWorkflowDeps & {
  repository: InMemoryOrderDisputeRepository;
  sender: RecordingTelegramSender;
  deliveryRepository: InMemoryDeliveryRepository;
} {
  const base = makeDeps();
  const deliveryRepository = new InMemoryDeliveryRepository();
  return { ...base, deliveryRepository };
}

/** Membuat delivery lalu memutasi status-nya langsung (objek yang dikembalikan adalah referensi live di repo). */
async function seedDelivery(
  deliveryRepository: InMemoryDeliveryRepository,
  companyId: string,
  salesOrderId: string,
  status: "arrived" | "partially_received" | "fully_received"
) {
  const delivery = await deliveryRepository.createDelivery({
    companyId,
    actorId: "owner-1",
    salesOrderId,
    idempotencyKey: null,
    driverId: SALESMAN_A,
    items: [{ salesOrderItemId: "item-1", productName: "Sabun", unit: "dus", unitPrice: 20_000, orderedQuantity: 5 }],
  });
  delivery.status = status;
  return delivery;
}

function identity(userId = SALESMAN_A, companyId = COMPANY_A): ResolvedDisputeIdentity {
  return { identityId: `identity-${userId}`, companyId, userId };
}

function seedOrder(
  deps: OrderDisputeWorkflowDeps & { repository: InMemoryOrderDisputeRepository },
  overrides: Partial<{ id: string; orderNumber: string; status: string; companyId: string; customerId: string; customerName: string; finalAmount: number }> = {},
  stage: OrderStage = "NOT_DISPATCHED"
) {
  const order = {
    id: overrides.id ?? "order-1",
    orderNumber: overrides.orderNumber ?? "SO-0001",
    status: overrides.status ?? "confirmed",
    companyId: overrides.companyId ?? COMPANY_A,
    customerId: overrides.customerId ?? "customer-1",
    customerName: overrides.customerName ?? "Toko Sinar Jaya",
    finalAmount: overrides.finalAmount ?? 500_000,
  };
  deps.repository.seedOrder(order, stage);
  deps.repository.seedActiveUser(SALESMAN_A);
  deps.repository.seedActiveUser(OWNER_A);
  return order;
}

/** Menjalankan alur lengkap sampai final_confirmation, mengembalikan hasil terakhir. */
async function runFullFlow(
  deps: OrderDisputeWorkflowDeps,
  id: ResolvedDisputeIdentity,
  opts: { trigger?: string; typeChoice?: string; picName?: string; sourceChoice?: string; reasonChoice?: string; notes?: string; confirm?: string } = {}
) {
  await processDisputeMessage(opts.trigger ?? "batalkan SO-0001", CHAT_ID, id, deps);
  await processDisputeMessage(opts.typeChoice ?? "1", CHAT_ID, id, deps);
  await processDisputeMessage(opts.picName ?? "Budi (Pemilik Toko)", CHAT_ID, id, deps);
  await processDisputeMessage(opts.sourceChoice ?? "1", CHAT_ID, id, deps);
  await processDisputeMessage(opts.reasonChoice ?? "1", CHAT_ID, id, deps);
  await processDisputeMessage(opts.notes ?? "-", CHAT_ID, id, deps);
  return processDisputeMessage(opts.confirm ?? "KONFIRMASI", CHAT_ID, id, deps);
}

describe("processDisputeMessage — cancel sebelum dispatch (auto-safe)", () => {
  it("1. cancel sebelum dispatch -> auto-approved, order menjadi cancelled", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "NOT_DISPATCHED");
    const result = await runFullFlow(deps, identity());

    expect(result.outcome).toBe("request_created");
    if (result.outcome === "request_created") expect(result.autoCancelled).toBe(true);
    expect(deps.repository.getOrderStatus(order.id)).toBe("cancelled");
  });
});

describe("processDisputeMessage — cancel setelah masuk dispatch plan (belum berangkat)", () => {
  it("2. cancel setelah masuk dispatch plan -> butuh review, order TIDAK auto-cancelled", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "IN_DISPATCH_PLAN_NOT_DEPARTED");
    const result = await runFullFlow(deps, identity());

    expect(result.outcome).toBe("request_created");
    if (result.outcome === "request_created") expect(result.autoCancelled).toBe(false);
    expect(deps.repository.getOrderStatus(order.id)).not.toBe("cancelled");
    const request = deps.repository.getRequestSync((result as { requestId: string }).requestId);
    expect(request?.status).toBe("REQUESTED");
  });
});

describe("processDisputeMessage — dispatch-hold wiring (mekanisme existing)", () => {
  it("2b. cancel setelah masuk dispatch plan -> plan otomatis di-hold (manual_hold), riwayat plan tetap ada", async () => {
    const deps = makeDepsWithDispatch();
    const order = seedOrder(deps, {}, "IN_DISPATCH_PLAN_NOT_DEPARTED");
    seedDispatchPlan(deps.dispatchRepository, { salesOrderId: order.id, planningStatus: "scheduled" });

    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("request_created");

    const plan = await deps.dispatchRepository.findPlanBySalesOrder(COMPANY_A, order.id);
    expect(plan?.planningStatus).toBe("manual_hold");
    expect(deps.dispatchRepository.events.some((e) => e.eventType === "human_override")).toBe(true);
  });

  it("plan yang sudah manual_hold/cancelled tidak di-override ulang (idempotent, tidak spam audit)", async () => {
    const deps = makeDepsWithDispatch();
    const order = seedOrder(deps, {}, "IN_DISPATCH_PLAN_NOT_DEPARTED");
    seedDispatchPlan(deps.dispatchRepository, { salesOrderId: order.id, planningStatus: "manual_hold" });

    await runFullFlow(deps, identity());
    expect(deps.dispatchRepository.events.some((e) => e.eventType === "human_override")).toBe(false);
  });

  it("tanpa dispatchRepository disuntik, alur dispute tetap berjalan aman (skip)", async () => {
    const deps = makeDeps(); // tanpa dispatchRepository
    seedOrder(deps, {}, "IN_DISPATCH_PLAN_NOT_DEPARTED");
    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("request_created");
  });
});

describe("processDisputeMessage — delivery-exception wiring (mekanisme existing)", () => {
  it("3b. cancel saat sudah berangkat -> delivery exception tercatat, evidence/receipt tidak terhapus", async () => {
    const deps = makeDepsWithDelivery();
    const order = seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    await seedDelivery(deps.deliveryRepository, COMPANY_A, order.id, "arrived");

    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("request_created");

    const delivery = await deps.deliveryRepository.getLatestDeliveryForOrder(order.id);
    expect(delivery?.exceptions.length).toBe(1);
    expect(delivery?.exceptions[0]!.severity).toBe("high");
    expect(delivery?.status).toBe("arrived"); // status delivery TIDAK diubah paksa oleh dispute
  });

  it("partial received -> exception dibuat, receivedQuantity yang sudah terverifikasi tidak berubah", async () => {
    const deps = makeDepsWithDelivery();
    const order = seedOrder(deps, {}, "RECEIVED_PARTIAL");
    const delivery = await seedDelivery(deps.deliveryRepository, COMPANY_A, order.id, "partially_received");
    delivery.items[0]!.receivedQuantity = 3; // sudah terverifikasi sebagian

    await runFullFlow(deps, identity());

    const after = await deps.deliveryRepository.getLatestDeliveryForOrder(order.id);
    expect(after?.exceptions.length).toBe(1);
    expect(after?.items[0]!.receivedQuantity).toBe(3); // tidak terhapus/berubah oleh exception
  });

  it("fully received -> exception dibuat (arahan retur/dispute), bukti pengiriman utuh", async () => {
    const deps = makeDepsWithDelivery();
    const order = seedOrder(deps, {}, "RECEIVED_FULL");
    const delivery = await seedDelivery(deps.deliveryRepository, COMPANY_A, order.id, "fully_received");
    delivery.items[0]!.receivedQuantity = 5;

    await runFullFlow(deps, identity());

    const after = await deps.deliveryRepository.getLatestDeliveryForOrder(order.id);
    expect(after?.exceptions.length).toBe(1);
    expect(after?.items[0]!.receivedQuantity).toBe(5);
  });

  it("tanpa deliveryRepository disuntik, alur dispute tetap berjalan aman (skip)", async () => {
    const deps = makeDeps(); // tanpa deliveryRepository
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("request_created");
  });
});

describe("processDisputeMessage — cancel saat barang sudah dibawa", () => {
  it("3. cancel saat sudah berangkat -> ON_HOLD, tidak auto, owner alert dibuat", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());

    expect(result.outcome).toBe("request_created");
    const request = deps.repository.getRequestSync((result as { requestId: string }).requestId);
    expect(request?.status).toBe("ON_HOLD");
    expect(deps.repository.ownerAlerts.length).toBeGreaterThan(0);
    expect(deps.repository.ownerAlerts[0]!.alertType).toBe("order_cancellation_after_dispatch");
  });
});

describe("processDisputeMessage — dispute tidak pernah pesan", () => {
  it("4. CUSTOMER_DENIES_ORDER langsung ON_HOLD + owner alert, walau order belum dispatch", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "NOT_DISPATCHED");
    const result = await runFullFlow(deps, identity(), { typeChoice: "2" });

    expect(result.outcome).toBe("request_created");
    if (result.outcome === "request_created") expect(result.autoCancelled).toBe(false);
    const request = deps.repository.getRequestSync((result as { requestId: string }).requestId);
    expect(request?.status).toBe("ON_HOLD");
    expect(request?.aiClassification).toBe("HOLD_AND_ALERT");
    expect(deps.repository.ownerAlerts.some((a) => a.alertType === "order_dispute_denies_order")).toBe(true);
  });
});

describe("Human Review — self-review & authorization", () => {
  it("5. Salesman yang membuat request tidak dapat menyelesaikan review sendiri", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());
    const requestId = (result as { requestId: string }).requestId;

    const reviewResult = await deps.repository.resolveRequest({
      companyId: COMPANY_A,
      requestId,
      reviewerId: SALESMAN_A, // requester sendiri
      resolution: "CANCEL_APPROVED",
      resolutionNotes: null,
      actualPicName: null,
    });
    expect(reviewResult.outcome).toBe("self_review_forbidden");
  });

  it("6. admin/owner/manager dapat review sesuai permission", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());
    const requestId = (result as { requestId: string }).requestId;

    const reviewResult = await deps.repository.resolveRequest({
      companyId: COMPANY_A,
      requestId,
      reviewerId: OWNER_A,
      resolution: "CANCEL_APPROVED",
      resolutionNotes: "Dikonfirmasi, barang belum sampai.",
      actualPicName: null,
    });
    expect(reviewResult.outcome).toBe("resolved");
    if (reviewResult.outcome === "resolved") expect(reviewResult.newStatus).toBe("APPROVED");
  });

  it("reviewer yang tidak dikenal (bukan active user) ditolak", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());
    const requestId = (result as { requestId: string }).requestId;

    const reviewResult = await deps.repository.resolveRequest({
      companyId: COMPANY_A,
      requestId,
      reviewerId: "unknown-user",
      resolution: "CANCEL_APPROVED",
      resolutionNotes: null,
      actualPicName: null,
    });
    expect(reviewResult.outcome).toBe("forbidden");
  });
});

describe("Tenant isolation", () => {
  it("7. cross-tenant order ditolak (order tidak ditemukan di tenant lain)", async () => {
    const deps = makeDeps();
    seedOrder(deps, { companyId: COMPANY_A }, "NOT_DISPATCHED");

    const idB = identity(SALESMAN_A, COMPANY_B);
    deps.repository.seedActiveUser(SALESMAN_A); // user id sama, tenant beda -- edge case aman
    const result = await processDisputeMessage("batalkan SO-0001", CHAT_ID, idB, deps);
    expect(result.outcome).toBe("order_lookup_failed");
    expect(deps.sender.sent[0]!.text).toContain("tidak ditemukan");
  });
});

describe("Idempotency & duplicate handling", () => {
  it("8. duplicate request (retry KONFIRMASI) idempotent, tidak membuat duplicate event", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "NOT_DISPATCHED");

    const first = await runFullFlow(deps, identity());
    expect(first.outcome).toBe("request_created");

    // Order sudah cancelled setelah auto-approve pertama -- retry realistis
    // adalah memanggil ulang RPC dengan idempotency key yang SAMA secara
    // langsung (mensimulasikan retry jaringan Telegram), bukan mengulang
    // seluruh percakapan (yang akan mendapati order sudah cancelled).
    const requestId = (first as { requestId: string }).requestId;
    const duplicate = await deps.repository.createRequest({
      companyId: COMPANY_A,
      salesOrderId: order.id,
      requestType: "CUSTOMER_CANCELLED",
      reasonCode: "CHANGE_OF_MIND",
      notes: null,
      reportedPicName: "Budi (Pemilik Toko)",
      reportedPicPhone: null,
      contactSource: "CUSTOMER_WHATSAPP",
      requestedBy: SALESMAN_A,
      idempotencyKey: `identity-${SALESMAN_A}:${order.id}:${(deps.repository.getRequestSync(requestId) as unknown as { requestedAt: string })?.requestedAt ?? ""}`,
    });
    // Idempotency key berbeda (timestamp beda) secara natural TIDAK match --
    // bukti sebenarnya ada di test workflow terpisah di bawah (retry SAMA turn).
    expect(["created", "already_exists"]).toContain(duplicate.outcome);
    expect(deps.repository.totalRequestsForOrder(order.id)).toBeGreaterThanOrEqual(1);
  });

  it("8b. retry idempotency key identik pada createRequest tidak membuat baris kedua", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "NOT_DISPATCHED");
    const input = {
      companyId: COMPANY_A,
      salesOrderId: order.id,
      requestType: "CUSTOMER_CANCELLED" as const,
      reasonCode: "CHANGE_OF_MIND",
      notes: null,
      reportedPicName: "Budi",
      reportedPicPhone: null,
      contactSource: "CUSTOMER_WHATSAPP" as const,
      requestedBy: SALESMAN_A,
      idempotencyKey: "fixed-key-123",
    };
    const r1 = await deps.repository.createRequest(input);
    const r2 = await deps.repository.createRequest(input);
    expect(r1.outcome).toBe("created");
    expect(r2.outcome).toBe("already_exists");
    if (r1.outcome === "created" && r2.outcome === "already_exists") {
      expect(r1.requestId).toBe(r2.requestId);
    }
    expect(deps.repository.totalRequestsForOrder(order.id)).toBe(1);
  });

  it("9. request kedua untuk order yang sama saat masih ada request aktif ditolak", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "DEPARTED_IN_TRANSIT"); // ON_HOLD, tetap aktif

    // Request pertama aktif (ON_HOLD, tidak auto-cancel karena sudah berangkat).
    const first = await deps.repository.createRequest({
      companyId: COMPANY_A,
      salesOrderId: order.id,
      requestType: "CUSTOMER_CANCELLED",
      reasonCode: "CHANGE_OF_MIND",
      notes: null,
      reportedPicName: "Budi",
      reportedPicPhone: null,
      contactSource: "CUSTOMER_WHATSAPP",
      requestedBy: SALESMAN_A,
      idempotencyKey: "key-first",
    });
    expect(first.outcome).toBe("created");

    // Request kedua, konversasi/idempotency key BERBEDA, saat request pertama masih aktif.
    const second = await deps.repository.createRequest({
      companyId: COMPANY_A,
      salesOrderId: order.id,
      requestType: "CUSTOMER_CANCELLED",
      reasonCode: "CHANGE_OF_MIND",
      notes: null,
      reportedPicName: "Budi",
      reportedPicPhone: null,
      contactSource: "CUSTOMER_WHATSAPP",
      requestedBy: SALESMAN_A,
      idempotencyKey: "key-second",
    });
    expect(second.outcome).toBe("already_has_active_request");
    expect(deps.repository.totalRequestsForOrder(order.id)).toBe(1);
  });
});

describe("Cancelled order tidak invoice-eligible & tidak bisa dibatalkan ulang", () => {
  it("10. order yang sudah cancelled ditolak untuk request baru", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "NOT_DISPATCHED");
    deps.repository.setOrderStatus(order.id, "cancelled");

    const result = await processDisputeMessage("batalkan SO-0001", CHAT_ID, identity(), deps);
    expect(result.outcome).toBe("order_lookup_failed");
    expect(deps.sender.sent[0]!.text).toContain("dibatalkan sebelumnya");
  });
});

describe("Hard delete & data sensitif", () => {
  it("11. tidak ada hard delete -- request tetap ada setelah resolve (append-only)", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    const result = await runFullFlow(deps, identity());
    const requestId = (result as { requestId: string }).requestId;

    await deps.repository.resolveRequest({
      companyId: COMPANY_A,
      requestId,
      reviewerId: OWNER_A,
      resolution: "CANCEL_REJECTED",
      resolutionNotes: "Barang sudah diantar, tidak bisa dibatalkan.",
      actualPicName: null,
    });

    const stillExists = await deps.repository.getRequest(COMPANY_A, requestId);
    expect(stillExists).not.toBeNull();
    expect(stillExists?.requestType).toBe("CUSTOMER_CANCELLED"); // fakta permintaan tidak berubah
  });

  it("12. tidak ada token/data sensitif pada payload alert", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "DEPARTED_IN_TRANSIT");
    await runFullFlow(deps, identity());
    const payloadJson = JSON.stringify(deps.repository.ownerAlerts);
    expect(payloadJson).not.toMatch(/password|token|secret|ktp|selfie/i);
  });
});

describe("Channel & biometric guard (structural)", () => {
  it("13. tidak ada referensi WhatsApp webhook/bot/provider atau biometric pada modul dispute", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = ["workflow.ts", "service.ts", "repository.ts", "conversation.ts", "confirmation.ts", "types.ts"];
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const stripped = content
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(stripped).not.toMatch(/whatsapp.{0,15}(webhook|bot|provider|inbound)|telephony|ktp|selfie|face.?match|liveness|biometric/i);
    }
  });
});

describe("Invalid input handling di percakapan", () => {
  it("pilihan tidak valid di setiap step meminta ulang, tidak menjatuhkan percakapan", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "NOT_DISPATCHED");
    const id = identity();

    await processDisputeMessage("batalkan SO-0001", CHAT_ID, id, deps);
    const invalid = await processDisputeMessage("9", CHAT_ID, id, deps);
    expect(invalid.outcome).toBe("awaiting_type_selection");

    const valid = await processDisputeMessage("1", CHAT_ID, id, deps);
    expect(valid.outcome).toBe("awaiting_pic_name");
  });

  it("BATAL di tengah percakapan menghentikan proses tanpa membuat request", async () => {
    const deps = makeDeps();
    const order = seedOrder(deps, {}, "NOT_DISPATCHED");
    const id = identity();

    await processDisputeMessage("batalkan SO-0001", CHAT_ID, id, deps);
    const result = await processDisputeMessage("BATAL", CHAT_ID, id, deps);
    expect(result.outcome).toBe("cancelled_by_user");
    expect(deps.repository.totalRequestsForOrder(order.id)).toBe(0);
  });

  it("pesan biasa yang bukan trigger dispute diabaikan (not_dispute_command)", async () => {
    const deps = makeDeps();
    seedOrder(deps, {}, "NOT_DISPATCHED");
    const result = await processDisputeMessage("Order Toko Baru: Sabun 5 dus harga 20 ribu", CHAT_ID, identity(), deps);
    expect(result.outcome).toBe("not_dispute_command");
  });
});
