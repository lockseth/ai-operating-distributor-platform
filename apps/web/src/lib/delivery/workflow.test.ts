// =============================================================================
// Test — Delivery Verification workflow. Menutup 15 skenario wajib task
// (full/partial/store_closed/rejected/changed-recipient/missing-evidence/
// duplicate/invoice-eligibility/no-delete/cross-tenant/unregistered/
// company_id-manipulation/owner-alert), seluruhnya via InMemoryDeliveryRepository
// — tidak butuh Supabase/Telegram sungguhan.
// =============================================================================

import { describe, it, expect } from "vitest";
import { processDeliveryConversation, type DeliveryWorkflowDeps } from "./workflow";
import { InMemoryDeliveryRepository } from "./repository";
import { computeInvoiceEligibility } from "./service";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/client";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const CHAT_ID = 2001;

const DRIVER_A: ResolvedIdentity = {
  identityId: "identity-driver-a",
  companyId: COMPANY_A,
  userId: "driver-a",
  userFullName: "Budi",
};

function makeDeps(): DeliveryWorkflowDeps & { repository: InMemoryDeliveryRepository; sender: RecordingTelegramSender } {
  return { repository: new InMemoryDeliveryRepository(), sender: new RecordingTelegramSender() };
}

async function seedDelivery(
  repo: InMemoryDeliveryRepository,
  opts: { companyId?: string; salesOrderId?: string; identity?: ResolvedIdentity } = {}
) {
  const companyId = opts.companyId ?? COMPANY_A;
  const salesOrderId = opts.salesOrderId ?? "order-default";
  const identity = opts.identity ?? DRIVER_A;

  repo.seedConfirmedOrder({
    id: salesOrderId,
    companyId,
    orderNumber: "SO-2607-0001",
    customerName: "Toko Sinar Jaya",
    status: "confirmed",
    items: [
      { id: `${salesOrderId}-item-1`, productName: "Cat Mawar Putih", unit: "dus", unitPrice: 450_000, quantity: 20 },
      { id: `${salesOrderId}-item-2`, productName: "Thinner Super", unit: "dus", unitPrice: 175_000, quantity: 10 },
    ],
  });
  const order = await repo.getConfirmedOrder(salesOrderId, companyId);
  const delivery = await repo.createDelivery({
    companyId,
    salesOrderId,
    idempotencyKey: `order:${salesOrderId}`,
    createdBy: "owner-1",
    items: order!.items.map((i) => ({
      salesOrderItemId: i.id,
      productName: i.productName,
      unit: i.unit,
      unitPrice: i.unitPrice,
      orderedQuantity: i.quantity,
    })),
  });
  await repo.assignDriver(delivery.id, identity.userId);
  await repo.setConversationState(identity.identityId, companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "start_confirmation",
    currentItemIndex: 0,
    draftState: {},
  });
  return delivery;
}

/** Order dengan SATU item, quantity dikustomisasi -- dipakai skenario invariant kuantitas agregat (order=100, dsb.). */
async function seedSingleItemDelivery(
  repo: InMemoryDeliveryRepository,
  opts: { companyId?: string; salesOrderId?: string; identity?: ResolvedIdentity; quantity: number }
) {
  const companyId = opts.companyId ?? COMPANY_A;
  const salesOrderId = opts.salesOrderId ?? "order-qty";
  const identity = opts.identity ?? DRIVER_A;

  repo.seedConfirmedOrder({
    id: salesOrderId,
    companyId,
    orderNumber: "SO-QTY-0001",
    customerName: "Toko Invariant",
    status: "confirmed",
    items: [{ id: `${salesOrderId}-item-1`, productName: "Cat Mawar Putih", unit: "dus", unitPrice: 450_000, quantity: opts.quantity }],
  });
  const order = await repo.getConfirmedOrder(salesOrderId, companyId);
  const delivery = await repo.createDelivery({
    companyId,
    salesOrderId,
    idempotencyKey: `order:${salesOrderId}:1`,
    createdBy: "owner-1",
    items: order!.items.map((i) => ({ salesOrderItemId: i.id, productName: i.productName, unit: i.unit, unitPrice: i.unitPrice, orderedQuantity: i.quantity })),
  });
  await repo.assignDriver(delivery.id, identity.userId);
  await repo.setConversationState(identity.identityId, companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "start_confirmation",
    currentItemIndex: 0,
    draftState: {},
  });
  return delivery;
}

/** Attempt baru (ke-2 dst) untuk order yang sudah ada -- items memakai OUTSTANDING terkini (bukan ordered asli), sesuai fix. */
async function seedNextAttempt(
  repo: InMemoryDeliveryRepository,
  opts: { companyId: string; salesOrderId: string; identity: ResolvedIdentity; attemptTag: string }
) {
  const order = await repo.getConfirmedOrder(opts.salesOrderId, opts.companyId);
  const delivery = await repo.createDelivery({
    companyId: opts.companyId,
    salesOrderId: opts.salesOrderId,
    idempotencyKey: `order:${opts.salesOrderId}:${opts.attemptTag}`,
    createdBy: "owner-1",
    items: order!.items.map((i) => ({ salesOrderItemId: i.id, productName: i.productName, unit: i.unit, unitPrice: i.unitPrice, orderedQuantity: i.quantity })),
  });
  await repo.assignDriver(delivery.id, opts.identity.userId);
  await repo.setConversationState(opts.identity.identityId, opts.companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "start_confirmation",
    currentItemIndex: 0,
    draftState: {},
  });
  return delivery;
}

function textMsg(text: string, messageId = 1): NonNullable<TelegramUpdate["message"]> {
  return { message_id: messageId, text, chat: { id: CHAT_ID }, from: { id: 9999, username: "budi" } };
}
function photoMsg(fileId: string, messageId = 1): NonNullable<TelegramUpdate["message"]> {
  return { message_id: messageId, photo: [{ file_id: fileId, width: 100, height: 100 }], chat: { id: CHAT_ID }, from: { id: 9999 } };
}
function locationMsg(latitude: number, longitude: number, messageId = 1): NonNullable<TelegramUpdate["message"]> {
  return { message_id: messageId, location: { latitude, longitude }, chat: { id: CHAT_ID }, from: { id: 9999 } };
}

let seq = 0;
async function step(
  deps: DeliveryWorkflowDeps & { repository: InMemoryDeliveryRepository },
  message: NonNullable<TelegramUpdate["message"]>,
  identity: ResolvedIdentity = DRIVER_A
) {
  seq += 1;
  const state = await deps.repository.getConversationState(identity.identityId);
  return processDeliveryConversation(message, CHAT_ID, identity, state, `evt-${seq}`, deps);
}

describe("Delivery Verification workflow", () => {
  it("1. full delivery -> status verified, invoice eligible = nilai penuh, tanpa variance", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-1" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("photo-1")); // photo
    await step(deps, photoMsg("sig-1")); // signature
    await step(deps, textMsg("Pak Andi (toko)")); // recipient
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(result.finalStatus).toBe("verified");

    const final = (await deps.repository.getDelivery(delivery.id))!;
    const eligibility = computeInvoiceEligibility(final);
    expect(eligibility.totalEligibleValue).toBe(20 * 450_000 + 10 * 175_000);
    expect(eligibility.varianceValue).toBe(0);
    expect(eligibility.isFinal).toBe(true);
  });

  it("2. partial delivery -> partially_received, invoice eligible hanya sejumlah diterima", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-2" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("15")); // item 1: terima 15 dari 20
    await step(deps, textMsg("10")); // item 2: terima 10 dari 10 (penuh)
    await step(deps, textMsg("2")); // reason #2 = CUSTOMER_PARTIAL_ACCEPTANCE
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Bu Sari"));
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(result.finalStatus).toBe("partially_received");

    const final = (await deps.repository.getDelivery(delivery.id))!;
    const eligibility = computeInvoiceEligibility(final);
    expect(eligibility.totalEligibleValue).toBe(15 * 450_000 + 10 * 175_000);
    expect(eligibility.varianceValue).toBe(5 * 450_000);
    expect(final.exceptions).toHaveLength(1);
    expect(final.exceptions[0]!.reasonCode).toBe("CUSTOMER_PARTIAL_ACCEPTANCE");
  });

  it("3. store closed -> tidak ada barang eligible invoice, WAJIB satu pending owner alert (reschedule)", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-3" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("TOKO TUTUP"));
    await step(deps, photoMsg("p1")); // foto wajib
    await step(deps, locationMsg(-6.2, 106.8)); // lokasi wajib untuk store_closed (DV-03)
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(result.finalStatus).toBe("store_closed");

    const final = (await deps.repository.getDelivery(delivery.id))!;
    const eligibility = computeInvoiceEligibility(final);
    expect(eligibility.totalEligibleValue).toBe(0);

    const alerts = deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("pending");
    expect(alerts[0]!.payload.acceptedValue).toBe(0);
    expect(alerts[0]!.payload.recommendation.toLowerCase()).toContain("jadwalkan ulang");
  });

  it("3b. failed delivery -> WAJIB satu pending owner alert dengan reason + evidence summary", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-3b" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("GAGAL"));
    await step(deps, textMsg("9")); // reason #9 = ADDRESS_NOT_FOUND
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(result.finalStatus).toBe("failed");

    const alerts = deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("pending");
    expect(alerts[0]!.payload.reason).toBe("ADDRESS_NOT_FOUND");
    expect(alerts[0]!.payload.evidenceSummary).toBe("tidak ada"); // GAGAL tidak mewajibkan evidence -- jujur, tidak dikarang
  });

  it("4. rejected delivery -> tidak eligible invoice, owner alert severity high", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-4" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITOLAK"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("3")); // reason #3 = CUSTOMER_REJECTED
    await step(deps, photoMsg("p1"));
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    if (result.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(result.finalStatus).toBe("rejected");

    const final = (await deps.repository.getDelivery(delivery.id))!;
    const eligibility = computeInvoiceEligibility(final);
    expect(eligibility.totalEligibleValue).toBe(0);
    const alerts = deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("high");
  });

  it("5. penerima berbeda dari attempt sebelumnya -> ditandai bukan PIC biasa + relationship event", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-5" });

    // Attempt 1: recipient "Pak Andi"
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Andi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    // Attempt 2 (re-delivery) untuk order yang sama, recipient berbeda.
    const order = await deps.repository.getConfirmedOrder("order-5", COMPANY_A);
    const delivery2 = await deps.repository.createDelivery({
      companyId: COMPANY_A,
      salesOrderId: "order-5",
      idempotencyKey: null,
      createdBy: "owner-1",
      items: order!.items.map((i) => ({
        salesOrderItemId: i.id,
        productName: i.productName,
        unit: i.unit,
        unitPrice: i.unitPrice,
        orderedQuantity: i.quantity,
      })),
    });
    await deps.repository.setConversationState(DRIVER_A.identityId, COMPANY_A, {
      pendingDeliveryId: delivery2.id,
      awaiting: "start_confirmation",
      currentItemIndex: 0,
      draftState: {},
    });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("p2"));
    await step(deps, photoMsg("s2"));
    await step(deps, textMsg("Bu Wati")); // penerima berbeda
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const final2 = (await deps.repository.getDelivery(delivery2.id))!;
    expect(final2.recipient?.recipientName).toBe("Bu Wati");
    expect(final2.recipient?.isExpectedPic).toBe(false);
    const relationshipEvents = deps.repository.events.filter(
      (e) => e.deliveryId === delivery2.id && e.eventType === "recipient_changed"
    );
    expect(relationshipEvents).toHaveLength(1);
  });

  it("6. evidence wajib belum lengkap -> submission ditolak, tetap di state evidence", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-6" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    // Hanya kirim foto -- signature & recipient masih kurang.
    const result = await step(deps, photoMsg("p1"));

    expect(result.outcome).toBe("evidence_recorded");
    const state = await deps.repository.getConversationState(DRIVER_A.identityId);
    expect(state.awaiting).toBe("evidence"); // belum lanjut ke final_confirmation
    const final = (await deps.repository.getDelivery(delivery.id))!;
    expect(final.status).not.toBe("verified");
  });

  it("7. duplicate KONFIRMASI KIRIM -> idempotent, tidak ada event/alert ganda", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-7" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("10"));
    await step(deps, textMsg("5"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    const first = await step(deps, textMsg("KONFIRMASI KIRIM"));
    const second = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(first.outcome).toBe("finalized");
    expect(second.outcome).toBe("finalized");
    if (first.outcome !== "finalized" || second.outcome !== "finalized") throw new Error("unexpected outcome");
    expect(first.alreadyFinalized).toBe(false);
    expect(second.alreadyFinalized).toBe(true);

    const finalizedEvents = deps.repository.events.filter((e) => e.deliveryId === delivery.id && e.eventType === "finalized");
    expect(finalizedEvents).toHaveLength(1);
    expect(deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id)).toHaveLength(1);
  });

  it("8. invoice eligibility hanya dari verified received_quantity, bukan ordered/dispatched", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-8" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("12"));
    await step(deps, textMsg("10"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const latest = (await deps.repository.getLatestDeliveryForOrder("order-8"))!;
    const eligibility = computeInvoiceEligibility(latest);
    expect(eligibility.items[0]!.eligibleQuantity).toBe(12); // bukan 20 (ordered) atau dispatched
    expect(eligibility.items[0]!.eligibleValue).toBe(12 * 450_000);
  });

  it("9. invoice eligible quantity tidak pernah melebihi received quantity", () => {
    const fakeDelivery = {
      id: "d1",
      companyId: COMPANY_A,
      salesOrderId: "order-x",
      attemptNumber: 1,
      assignedDriverId: null,
      status: "partially_received" as const,
      items: [
        {
          id: "i1",
          salesOrderItemId: "soi-1",
          productName: "X",
          unit: "dus",
          unitPrice: 1000,
          orderedQuantity: 100,
          dispatchedQuantity: 100,
          receivedQuantity: 40,
          rejectedQuantity: 60,
          returnedQuantity: 0,
          unresolvedQuantity: 0,
        },
      ],
      exceptions: [],
      evidence: [],
      recipient: null,
      deliveryNumber: null,
      deliveryDate: null,
    };
    const eligibility = computeInvoiceEligibility(fakeDelivery);
    expect(eligibility.items[0]!.eligibleQuantity).toBe(40);
    expect(eligibility.items[0]!.eligibleQuantity).toBeLessThanOrEqual(fakeDelivery.items[0]!.receivedQuantity);
    expect(eligibility.items[0]!.eligibleQuantity).toBeLessThan(fakeDelivery.items[0]!.orderedQuantity);
  });

  it("10. repository interface tidak menyediakan operasi hapus untuk evidence/exception/audit event", () => {
    // Jaminan utama ada di RLS migration (tidak ada policy UPDATE/DELETE untuk
    // delivery_evidence/delivery_events, dan delivery_exceptions hanya boleh
    // UPDATE resolution_status oleh delivery.manage -- lihat
    // supabase/migrations/20260716000001_delivery_verification.sql). Test ini
    // memastikan lapisan TypeScript juga tidak mengekspos API hapus sama sekali.
    const repo = new InMemoryDeliveryRepository() as unknown as Record<string, unknown>;
    expect(repo.deleteEvidence).toBeUndefined();
    expect(repo.deleteException).toBeUndefined();
    expect(repo.deleteEvent).toBeUndefined();
    expect(repo.deleteDeliveryEvent).toBeUndefined();
  });

  it("11. cross-tenant access ditolak -- company B tidak bisa membaca order/delivery company A", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-11" });

    const crossTenantOrder = await deps.repository.getConfirmedOrder("order-11", COMPANY_B);
    expect(crossTenantOrder).toBeNull();

    const crossTenantByKey = await deps.repository.findDeliveryByIdempotencyKey(COMPANY_B, "order:order-11");
    expect(crossTenantByKey).toBeNull();
  });

  it("12. Telegram identity tidak terdaftar -> tidak pernah mencapai logika delivery", async () => {
    // Dispatch ke delivery hanya terjadi SETELAH resolveIdentity() berhasil di
    // sales-orders/workflow.ts (lihat lib/sales-orders/workflow.ts) -- chat_id
    // yang belum terdaftar berhenti sebelum delivery_conversation_state
    // sempat dibaca sama sekali. Diverifikasi penuh di
    // sales-orders/workflow.test.ts skenario 7; di sini kita pastikan
    // getConversationState() untuk identity yang TIDAK PERNAH di-seed selalu
    // mengembalikan 'none' (fail closed, bukan diam-diam mengizinkan).
    const deps = makeDeps();
    const state = await deps.repository.getConversationState("identity-yang-tidak-pernah-didaftarkan");
    expect(state.awaiting).toBe("none");
    expect(state.pendingDeliveryId).toBeNull();
  });

  it("13. company_id di draft/state tidak pernah dibaca dari input driver -- selalu dari identity server-side", async () => {
    const deps = makeDeps();
    const deliveryA = await seedDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-13a" });
    const driverB: ResolvedIdentity = { identityId: "identity-driver-b", companyId: COMPANY_B, userId: "driver-b", userFullName: "Wati" };
    const deliveryB = await seedDelivery(deps.repository, { companyId: COMPANY_B, salesOrderId: "order-13b", identity: driverB });

    await step(deps, textMsg("MULAI KIRIM"), DRIVER_A);
    await step(deps, textMsg("DITERIMA PENUH"), DRIVER_A);
    await step(deps, photoMsg("pa"), DRIVER_A);
    await step(deps, photoMsg("sa"), DRIVER_A);
    await step(deps, textMsg("Pak A"), DRIVER_A);
    await step(deps, textMsg("KONFIRMASI KIRIM"), DRIVER_A);

    await step(deps, textMsg("MULAI KIRIM"), driverB);
    await step(deps, textMsg("DITOLAK"), driverB);
    await step(deps, textMsg("0"), driverB);
    await step(deps, textMsg("0"), driverB);
    await step(deps, textMsg("3"), driverB);
    await step(deps, photoMsg("pb"), driverB);
    await step(deps, textMsg("KONFIRMASI KIRIM"), driverB);

    // Setiap event/exception/alert hanya tercatat di company_id identity yang
    // memprosesnya masing-masing -- tidak ada percampuran tenant walau kedua
    // driver diproses dalam repository in-memory yang sama.
    const eventsForA = deps.repository.events.filter((e) => e.deliveryId === deliveryA.id);
    const eventsForB = deps.repository.events.filter((e) => e.deliveryId === deliveryB.id);
    expect(eventsForA.every((e) => e.companyId === COMPANY_A)).toBe(true);
    expect(eventsForB.every((e) => e.companyId === COMPANY_B)).toBe(true);

    const alertsForA = deps.repository.ownerAlerts.filter((a) => a.deliveryId === deliveryA.id);
    const alertsForB = deps.repository.ownerAlerts.filter((a) => a.deliveryId === deliveryB.id);
    expect(alertsForA).toHaveLength(0); // full delivery, tidak ada variance
    expect(alertsForB.every((a) => a.companyId === COMPANY_B)).toBe(true);
  });

  it("14. owner alert terbentuk berisi kontrak field lengkap saat ada variance", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-14" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("18"));
    await step(deps, textMsg("10"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const alert = deps.repository.ownerAlerts.at(-1)!;
    expect(alert.channel).toBe("whatsapp");
    expect(alert.payload.orderedValue).toBeGreaterThan(0);
    expect(alert.payload.acceptedValue).toBeGreaterThan(0);
    expect(alert.payload.varianceValue).toBe(2 * 450_000);
    expect(alert.payload.reason).toBe("CUSTOMER_PARTIAL_ACCEPTANCE");
    expect(alert.payload.recommendation.length).toBeGreaterThan(0);
    expect(alert.status).toBe("pending"); // tidak pernah langsung 'sent' -- lihat item 15 laporan
  });

  it("15. full delivery tanpa variance TIDAK menghasilkan owner alert", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { salesOrderId: "order-15" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Gap-closure fix (audit atas commit 1adc2bb): owner alert coverage
  // berbasis dampak bisnis + sinkronisasi lifecycle agregat sales_orders.
  // ---------------------------------------------------------------------

  it("16. owner alert selalu tertandai company_id pembuatnya -- tidak pernah terbaca lintas tenant", async () => {
    const deps = makeDeps();
    const deliveryA = await seedDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-16" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITOLAK"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("3"));
    await step(deps, photoMsg("p1"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    // Company B tidak pernah punya baris alert milik company A -- penegakan
    // sesungguhnya di production adalah RLS policy "owner_alerts_select"
    // (migration 20260716000001) yang mensyaratkan company_id =
    // get_user_company_id(), tanpa policy lintas tenant sama sekali.
    expect(deps.repository.ownerAlerts.filter((a) => a.companyId === COMPANY_B)).toHaveLength(0);
    const alertsForA = deps.repository.ownerAlerts.filter((a) => a.companyId === COMPANY_A && a.deliveryId === deliveryA.id);
    expect(alertsForA).toHaveLength(1);
  });

  it("17. teks bebas berisi 'company_id' tidak pernah memengaruhi tenant alert -- selalu dari identity server-side", async () => {
    const deps = makeDeps();
    const delivery = await seedDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-17" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITOLAK"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("0"));
    await step(deps, textMsg("11")); // OTHER_REQUIRES_NOTE
    // TelegramUpdate tidak punya field company_id sama sekali -- mencoba
    // menyisipkannya lewat teks bebas (catatan reason) tidak pernah dibaca
    // sebagai identitas tenant oleh workflow manapun.
    await step(deps, textMsg("company_id: company-b -- barang rusak saat perjalanan"));
    await step(deps, photoMsg("p1"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const alerts = deps.repository.ownerAlerts.filter((a) => a.deliveryId === delivery.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.companyId).toBe(COMPANY_A);
  });

  it("18. MULAI KIRIM (dispatch pertama) mengubah sales_orders.status confirmed -> delivering", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-18" });
    const before = await deps.repository.getConfirmedOrder("order-18", COMPANY_A);
    expect(before!.status).toBe("confirmed");

    await step(deps, textMsg("MULAI KIRIM"));

    const after = await deps.repository.getConfirmedOrder("order-18", COMPANY_A);
    expect(after!.status).toBe("delivering");
  });

  it("19. full verified delivery -> sales_orders.status delivering -> delivered", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-19" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const after = await deps.repository.getConfirmedOrder("order-19", COMPANY_A);
    expect(after!.status).toBe("delivered");
  });

  it("20. partial delivery -> sales_orders.status tetap delivering, bukan delivered", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-20" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("15"));
    await step(deps, textMsg("10"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const after = await deps.repository.getConfirmedOrder("order-20", COMPANY_A);
    expect(after!.status).toBe("delivering");
  });

  it("21. store closed -> sales_orders.status tetap delivering, tidak pernah delivered", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-21" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("TOKO TUTUP"));
    await step(deps, photoMsg("p1"));
    await step(deps, locationMsg(-6.2, 106.8));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const after = await deps.repository.getConfirmedOrder("order-21", COMPANY_A);
    expect(after!.status).not.toBe("delivered");
    expect(after!.status).toBe("delivering");
  });

  it("22. failed delivery -> sales_orders.status tetap delivering, tidak pernah delivered", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-22" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("GAGAL"));
    await step(deps, textMsg("9"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const after = await deps.repository.getConfirmedOrder("order-22", COMPANY_A);
    expect(after!.status).not.toBe("delivered");
    expect(after!.status).toBe("delivering");
  });

  it("23. dua delivery attempt yang secara agregat memenuhi order -> delivered (tidak double count)", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-23" });

    // Attempt 1: partial, terima 15/20 item1, 10/10 item2 (item2 sudah penuh).
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("15"));
    await step(deps, textMsg("10"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    let order = await deps.repository.getConfirmedOrder("order-23", COMPANY_A);
    expect(order!.status).toBe("delivering"); // item1 belum penuh (15/20)

    // Attempt 2 (re-delivery) khusus sisa item1. Catatan MVP: attempt baru
    // men-snapshot ordered_quantity dari ORIGINAL sales_order_item (20),
    // bukan sisa outstanding -- kualitas agregasi yang diuji di sini adalah
    // SUM received_quantity lintas attempt, bukan validasi sisa per attempt.
    const item1 = order!.items[0]!;
    const delivery2 = await deps.repository.createDelivery({
      companyId: COMPANY_A,
      salesOrderId: "order-23",
      idempotencyKey: null,
      createdBy: "owner-1",
      items: [
        {
          salesOrderItemId: item1.id,
          productName: item1.productName,
          unit: item1.unit,
          unitPrice: item1.unitPrice,
          orderedQuantity: item1.quantity,
        },
      ],
    });
    await deps.repository.assignDriver(delivery2.id, DRIVER_A.userId);
    await deps.repository.setConversationState(DRIVER_A.identityId, COMPANY_A, {
      pendingDeliveryId: delivery2.id,
      awaiting: "start_confirmation",
      currentItemIndex: 0,
      draftState: {},
    });

    // Terima 5 sisanya -> total received item1 = 15 + 5 = 20 = ordered.
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("5"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p2"));
    await step(deps, photoMsg("s2"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    order = await deps.repository.getConfirmedOrder("order-23", COMPANY_A);
    expect(order!.status).toBe("delivered");
  });

  it("24. duplicate KONFIRMASI KIRIM pada delivery yang sudah final tidak mengubah lifecycle order dua kali", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { salesOrderId: "order-24" });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM")); // finalize pertama -> delivered
    await step(deps, textMsg("KONFIRMASI KIRIM")); // retry -- idempotent, tidak error/berubah

    const order = await deps.repository.getConfirmedOrder("order-24", COMPANY_A);
    expect(order!.status).toBe("delivered");
  });

  it("25. delivery milik tenant lain tidak memengaruhi status order tenant lain", async () => {
    const deps = makeDeps();
    await seedDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-25a" });
    const driverB: ResolvedIdentity = { identityId: "identity-driver-b25", companyId: COMPANY_B, userId: "driver-b25", userFullName: "Wati" };
    await seedDelivery(deps.repository, { companyId: COMPANY_B, salesOrderId: "order-25b", identity: driverB });

    // Selesaikan delivery company B secara penuh -- company A tidak disentuh sama sekali.
    await step(deps, textMsg("MULAI KIRIM"), driverB);
    await step(deps, textMsg("DITERIMA PENUH"), driverB);
    await step(deps, photoMsg("pb"), driverB);
    await step(deps, photoMsg("sb"), driverB);
    await step(deps, textMsg("Bu Wati"), driverB);
    await step(deps, textMsg("KONFIRMASI KIRIM"), driverB);

    const orderA = await deps.repository.getConfirmedOrder("order-25a", COMPANY_A);
    const orderB = await deps.repository.getConfirmedOrder("order-25b", COMPANY_B);
    expect(orderA!.status).toBe("confirmed"); // belum ada MULAI KIRIM company A sama sekali
    expect(orderB!.status).toBe("delivered");
  });

  // ---------------------------------------------------------------------
  // Audit invariant kuantitas agregat (audit atas commit 400b114): SUM
  // received_quantity lintas delivery attempt untuk satu sales_order_item
  // TIDAK PERNAH boleh melebihi ordered_quantity.
  // ---------------------------------------------------------------------

  it("26. attempt kedua mencoba menerima lebih dari outstanding (order=100, A=60, B coba 50) -> ditolak, bukan silent clamp", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { salesOrderId: "order-26", quantity: 100 });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("60"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    const orderAfterA = await deps.repository.getConfirmedOrder("order-26", COMPANY_A);
    expect(orderAfterA!.status).toBe("delivering");

    const deliveryB = await seedNextAttempt(deps.repository, {
      companyId: COMPANY_A,
      salesOrderId: "order-26",
      identity: DRIVER_A,
      attemptTag: "B",
    });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    const rejectResult = await step(deps, textMsg("50")); // outstanding sekarang hanya 40

    expect(rejectResult.outcome).toBe("invalid_input"); // ditolak, TIDAK diloloskan/di-clamp diam-diam
    const deliveryBState = await deps.repository.getDelivery(deliveryB.id);
    expect(deliveryBState!.items[0]!.receivedQuantity).toBe(0);
  });

  it("27. dua delivery attempt confirm hampir bersamaan (dibuat sebelum salah satu commit) -> yang kedua ditolak atomic, total tidak pernah melebihi ordered", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { salesOrderId: "order-27", quantity: 100 });
    const order = await deps.repository.getConfirmedOrder("order-27", COMPANY_A);
    const item = order!.items[0]!;

    // Dua delivery attempt dibuat SEBELUM salah satu commit -- keduanya
    // masih melihat ordered_quantity 100 penuh sebagai dispatched masing-masing
    // (mensimulasikan dua attempt yang benar-benar berjalan bersamaan).
    const deliveryA = await deps.repository.createDelivery({
      companyId: COMPANY_A,
      salesOrderId: "order-27",
      idempotencyKey: "order:order-27:A",
      createdBy: "owner-1",
      items: [{ salesOrderItemId: item.id, productName: item.productName, unit: item.unit, unitPrice: item.unitPrice, orderedQuantity: 100 }],
    });
    await deps.repository.assignDriver(deliveryA.id, DRIVER_A.userId);

    const driverB: ResolvedIdentity = { identityId: "identity-driver-b27", companyId: COMPANY_A, userId: "driver-b27", userFullName: "Wati" };
    const deliveryB = await deps.repository.createDelivery({
      companyId: COMPANY_A,
      salesOrderId: "order-27",
      idempotencyKey: "order:order-27:B",
      createdBy: "owner-1",
      items: [{ salesOrderItemId: item.id, productName: item.productName, unit: item.unit, unitPrice: item.unitPrice, orderedQuantity: 100 }],
    });
    await deps.repository.assignDriver(deliveryB.id, driverB.userId);

    await deps.repository.setConversationState(DRIVER_A.identityId, COMPANY_A, {
      pendingDeliveryId: deliveryA.id,
      awaiting: "start_confirmation",
      currentItemIndex: 0,
      draftState: {},
    });
    await deps.repository.setConversationState(driverB.identityId, COMPANY_A, {
      pendingDeliveryId: deliveryB.id,
      awaiting: "start_confirmation",
      currentItemIndex: 0,
      draftState: {},
    });

    // A: sampai ke preview (terima 60) -- belum confirm.
    await step(deps, textMsg("MULAI KIRIM"), DRIVER_A);
    await step(deps, textMsg("DITERIMA SEBAGIAN"), DRIVER_A);
    await step(deps, textMsg("60"), DRIVER_A);
    await step(deps, textMsg("2"), DRIVER_A);
    await step(deps, photoMsg("pa"), DRIVER_A);
    await step(deps, photoMsg("sa"), DRIVER_A);
    await step(deps, textMsg("Pak Budi"), DRIVER_A);

    // B: sampai ke preview (terima 50) -- independen, belum tahu A akan commit duluan.
    await step(deps, textMsg("MULAI KIRIM"), driverB);
    await step(deps, textMsg("DITERIMA SEBAGIAN"), driverB);
    await step(deps, textMsg("50"), driverB);
    await step(deps, textMsg("2"), driverB);
    await step(deps, photoMsg("pb"), driverB);
    await step(deps, photoMsg("sb"), driverB);
    await step(deps, textMsg("Bu Wati"), driverB);

    const resultA = await step(deps, textMsg("KONFIRMASI KIRIM"), DRIVER_A);
    expect(resultA.outcome).toBe("finalized");

    const resultB = await step(deps, textMsg("KONFIRMASI KIRIM"), driverB);
    expect(resultB.outcome).toBe("quantity_conflict"); // atomic check menolak, bukan silent clamp

    const deliveryBFinal = await deps.repository.getDelivery(deliveryB.id);
    expect(deliveryBFinal!.status).not.toBe("partially_received");
    expect(deliveryBFinal!.items[0]!.receivedQuantity).toBe(0);

    const deliveryAFinal = await deps.repository.getDelivery(deliveryA.id);
    expect(deliveryAFinal!.items[0]!.receivedQuantity).toBe(60); // total tetap 60, tidak pernah 110
  });

  it("28. 60 + 40 = tepat outstanding -> diterima (boundary, bukan ditolak), order menjadi delivered", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { salesOrderId: "order-28", quantity: 100 });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("60"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    await seedNextAttempt(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-28", identity: DRIVER_A, attemptTag: "B" });
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA PENUH")); // outstanding=40, full -> otomatis terima seluruh dispatched (40)
    await step(deps, photoMsg("p2"));
    await step(deps, photoMsg("s2"));
    await step(deps, textMsg("Pak Budi"));
    const result = await step(deps, textMsg("KONFIRMASI KIRIM"));

    expect(result.outcome).toBe("finalized");
    const order = await deps.repository.getConfirmedOrder("order-28", COMPANY_A);
    expect(order!.status).toBe("delivered");

    const aggregate = await deps.repository.getAggregateInvoiceEligibilityData("order-28");
    expect(aggregate[0]!.aggregateReceivedQuantity).toBe(100);
    expect(aggregate[0]!.orderedQuantity).toBe(100);
    expect(aggregate[0]!.aggregateReceivedQuantity).toBeLessThanOrEqual(aggregate[0]!.orderedQuantity);
  });

  it("29. retry KONFIRMASI KIRIM pada delivery yang sama tidak menulis quantity dua kali (idempotent)", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { salesOrderId: "order-29", quantity: 100 });

    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITERIMA SEBAGIAN"));
    await step(deps, textMsg("60"));
    await step(deps, textMsg("2"));
    await step(deps, photoMsg("p1"));
    await step(deps, photoMsg("s1"));
    await step(deps, textMsg("Pak Budi"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));
    await step(deps, textMsg("KONFIRMASI KIRIM")); // retry

    const aggregate = await deps.repository.getAggregateInvoiceEligibilityData("order-29");
    expect(aggregate[0]!.aggregateReceivedQuantity).toBe(60); // bukan 120
  });

  it("30. failed/rejected/store_closed tidak dihitung sebagai received kecuali porsi yang benar-benar diterima", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { salesOrderId: "order-30", quantity: 100 });

    // Attempt A: gagal total -- tidak ada barang berpindah tangan.
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("GAGAL"));
    await step(deps, textMsg("9"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    let outstanding = await deps.repository.getOutstandingQuantity("order-30-item-1", null);
    expect(outstanding).toBe(100); // failed tidak mengurangi outstanding sama sekali

    // Attempt B (redelivery): toko tutup -- juga tidak ada yang diterima.
    await seedNextAttempt(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-30", identity: DRIVER_A, attemptTag: "B" });
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("TOKO TUTUP"));
    await step(deps, photoMsg("p1"));
    await step(deps, locationMsg(-6.2, 106.8));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    outstanding = await deps.repository.getOutstandingQuantity("order-30-item-1", null);
    expect(outstanding).toBe(100); // masih 100 -- belum ada satu pun yang benar-benar diterima

    // Attempt C: ditolak SEBAGIAN -- 30 diterima, 70 ditolak. Hanya porsi
    // yang BENAR-BENAR diterima (30) yang mengurangi outstanding.
    await seedNextAttempt(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-30", identity: DRIVER_A, attemptTag: "C" });
    await step(deps, textMsg("MULAI KIRIM"));
    await step(deps, textMsg("DITOLAK"));
    await step(deps, textMsg("30"));
    await step(deps, textMsg("3"));
    await step(deps, photoMsg("pc"));
    await step(deps, textMsg("KONFIRMASI KIRIM"));

    outstanding = await deps.repository.getOutstandingQuantity("order-30-item-1", null);
    expect(outstanding).toBe(70); // 100 - 30, bukan 100 - 100
  });

  it("31. outstanding/aggregate quantity tenant lain tidak terbaca atau terpengaruh lintas company", async () => {
    const deps = makeDeps();
    await seedSingleItemDelivery(deps.repository, { companyId: COMPANY_A, salesOrderId: "order-31a", quantity: 100 });
    const driverB: ResolvedIdentity = { identityId: "identity-driver-b31", companyId: COMPANY_B, userId: "driver-b31", userFullName: "Wati" };
    await seedSingleItemDelivery(deps.repository, { companyId: COMPANY_B, salesOrderId: "order-31b", identity: driverB, quantity: 100 });

    await step(deps, textMsg("MULAI KIRIM"), driverB);
    await step(deps, textMsg("DITERIMA PENUH"), driverB);
    await step(deps, photoMsg("pb"), driverB);
    await step(deps, photoMsg("sb"), driverB);
    await step(deps, textMsg("Bu Wati"), driverB);
    await step(deps, textMsg("KONFIRMASI KIRIM"), driverB);

    const outstandingA = await deps.repository.getOutstandingQuantity("order-31a-item-1", null);
    expect(outstandingA).toBe(100); // tidak terpengaruh delivery company B sama sekali

    const orderA = await deps.repository.getConfirmedOrder("order-31a", COMPANY_A);
    expect(orderA!.status).toBe("confirmed");

    const crossRead = await deps.repository.getConfirmedOrder("order-31a", COMPANY_B);
    expect(crossRead).toBeNull(); // cross-tenant read ditolak
  });
});
