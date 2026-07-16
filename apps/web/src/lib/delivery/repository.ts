// =============================================================================
// Repository — abstraksi persistence untuk Delivery Verification.
//
// Identitas Telegram (resolveIdentity) dan idempotency ledger
// (telegram_update_events) TIDAK diduplikasi di sini — keduanya dipakai
// bersama dari SalesOrderTelegramRepository (lihat lib/sales-orders/repository.ts)
// karena satu identity/satu ledger yang sama melayani seluruh alur Telegram
// AODP (order maupun delivery). Interface ini murni domain Delivery.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DeliveryRecord,
  DeliveryItemRecord,
  DeliveryStatus,
  DeliveryExceptionInput,
  DeliveryExceptionRecord,
  DeliveryEvidenceInput,
  DeliveryEvidenceRecord,
  RecipientInput,
  OwnerAlertPayload,
  ExceptionSeverity,
} from "./types";

export interface ConfirmedOrderItemSnapshot {
  id: string;
  productName: string;
  unit: string | null;
  unitPrice: number;
  quantity: number;
}

export interface ConfirmedOrderSnapshot {
  id: string;
  companyId: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  items: ConfirmedOrderItemSnapshot[];
}

export type DeliveryConversationAwaiting =
  | "none"
  | "start_confirmation"
  | "outcome_selection"
  | "item_quantity"
  | "reason_selection"
  | "reason_note"
  | "evidence"
  | "final_confirmation";

export interface DeliveryConversationState {
  pendingDeliveryId: string | null;
  awaiting: DeliveryConversationAwaiting;
  currentItemIndex: number;
  draftState: Record<string, unknown>;
}

export interface DeliveryEventInput {
  companyId: string;
  deliveryId: string;
  eventType: string;
  fromStatus: DeliveryStatus | null;
  toStatus: DeliveryStatus | null;
  actorId: string | null;
  telegramUpdateEventId: string | null;
  payload: Record<string, unknown>;
}

export interface OwnerAlertInsertInput {
  companyId: string;
  salesOrderId: string | null;
  deliveryId: string | null;
  alertType: string;
  channel: "whatsapp";
  severity: ExceptionSeverity;
  payload: OwnerAlertPayload;
}

export interface DeliveryRepositoryInterface {
  getConfirmedOrder(salesOrderId: string, companyId: string): Promise<ConfirmedOrderSnapshot | null>;

  findDeliveryByIdempotencyKey(companyId: string, idempotencyKey: string): Promise<DeliveryRecord | null>;

  createDelivery(input: {
    companyId: string;
    salesOrderId: string;
    idempotencyKey: string | null;
    createdBy: string | null;
    items: { salesOrderItemId: string; productName: string; unit: string | null; unitPrice: number; orderedQuantity: number }[];
  }): Promise<DeliveryRecord>;

  getDelivery(deliveryId: string): Promise<DeliveryRecord | null>;

  /** Delivery paling relevan untuk order ini — attempt terbaru yang belum terminal, atau attempt terbaru bila semua sudah terminal. */
  getLatestDeliveryForOrder(salesOrderId: string): Promise<DeliveryRecord | null>;

  assignDriver(deliveryId: string, driverId: string): Promise<void>;

  /**
   * Sinkronisasi atomic lifecycle agregat sales_orders.status dari total
   * received_quantity lintas seluruh delivery attempt milik order ini.
   * Idempoten — aman dipanggil berulang. Lihat migration
   * `sync_sales_order_delivery_status` (Supabase) untuk implementasi atomic
   * (row lock + agregat dalam satu transaksi fungsi).
   */
  syncSalesOrderStatus(salesOrderId: string): Promise<string | null>;

  /** MVP: dispatched_quantity = ordered_quantity untuk semua item (lihat catatan scope di service.ts). */
  recordDispatch(deliveryId: string): Promise<void>;

  recordArrival(deliveryId: string): Promise<void>;

  updateItemOutcome(
    deliveryItemId: string,
    patch: Partial<{
      receivedQuantity: number;
      rejectedQuantity: number;
      returnedQuantity: number;
      unresolvedQuantity: number;
    }>
  ): Promise<void>;

  /** Idempotent: memanggil ulang pada delivery yang sudah terminal tidak mengubah apa pun. */
  finalizeDelivery(deliveryId: string, finalStatus: DeliveryStatus): Promise<{ delivery: DeliveryRecord; alreadyFinalized: boolean }>;

  insertException(companyId: string, deliveryId: string, input: DeliveryExceptionInput, actorId: string | null): Promise<DeliveryExceptionRecord>;

  insertEvidence(companyId: string, deliveryId: string, input: DeliveryEvidenceInput, actorId: string | null): Promise<DeliveryEvidenceRecord>;

  insertRecipient(companyId: string, deliveryId: string, input: RecipientInput): Promise<void>;

  /** Nama penerima pada attempt SEBELUMNYA untuk sales_order yang sama — dipakai mendeteksi pergantian PIC (DV-05). Null bila belum ada attempt sebelumnya atau belum ada recipient tercatat. */
  getPreviousRecipientName(salesOrderId: string, beforeAttemptNumber: number): Promise<string | null>;

  insertEvent(input: DeliveryEventInput): Promise<void>;

  getConversationState(identityId: string): Promise<DeliveryConversationState>;

  setConversationState(identityId: string, companyId: string, state: DeliveryConversationState): Promise<void>;

  insertOwnerAlert(input: OwnerAlertInsertInput): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Supabase-backed implementation
// ---------------------------------------------------------------------------

export class SupabaseDeliveryRepository implements DeliveryRepositoryInterface {
  constructor(private readonly supabase: SupabaseClient) {}

  async getConfirmedOrder(salesOrderId: string, companyId: string): Promise<ConfirmedOrderSnapshot | null> {
    const { data } = await this.supabase
      .from("sales_orders")
      .select(
        "id, company_id, order_number, status, customer:customers!customer_id(name), customer_name_raw, items:sales_order_items(id, quantity, unit, unit_price, product_name_raw, product:products!product_id(name))"
      )
      .eq("id", salesOrderId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (!data) return null;
    const row = data as unknown as {
      id: string;
      company_id: string;
      order_number: string;
      status: string;
      customer: { name: string } | null;
      customer_name_raw: string | null;
      items: {
        id: string;
        quantity: number;
        unit: string | null;
        unit_price: number;
        product_name_raw: string | null;
        product: { name: string } | null;
      }[];
    };

    return {
      id: row.id,
      companyId: row.company_id,
      orderNumber: row.order_number,
      customerName: row.customer?.name ?? row.customer_name_raw,
      status: row.status,
      items: row.items.map((i) => ({
        id: i.id,
        productName: i.product?.name ?? i.product_name_raw ?? "(produk)",
        unit: i.unit,
        unitPrice: i.unit_price,
        quantity: i.quantity,
      })),
    };
  }

  async findDeliveryByIdempotencyKey(companyId: string, idempotencyKey: string): Promise<DeliveryRecord | null> {
    const { data } = await this.supabase
      .from("deliveries")
      .select("id")
      .eq("company_id", companyId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (!data) return null;
    return this.getDelivery((data as { id: string }).id);
  }

  async createDelivery(input: {
    companyId: string;
    salesOrderId: string;
    idempotencyKey: string | null;
    createdBy: string | null;
    items: { salesOrderItemId: string; productName: string; unit: string | null; unitPrice: number; orderedQuantity: number }[];
  }): Promise<DeliveryRecord> {
    const { count } = await this.supabase
      .from("deliveries")
      .select("id", { count: "exact", head: true })
      .eq("sales_order_id", input.salesOrderId);
    const attemptNumber = (count ?? 0) + 1;

    const { data: headerRow, error: headerError } = await this.supabase
      .from("deliveries")
      .insert({
        company_id: input.companyId,
        sales_order_id: input.salesOrderId,
        attempt_number: attemptNumber,
        idempotency_key: input.idempotencyKey,
        created_by: input.createdBy,
        status: "planned",
      })
      .select("id")
      .single();
    if (headerError) throw new Error(`createDelivery failed: ${headerError.message}`);
    const deliveryId = (headerRow as { id: string }).id;

    if (input.items.length > 0) {
      const { error: itemsError } = await this.supabase.from("delivery_items").insert(
        input.items.map((item) => ({
          delivery_id: deliveryId,
          sales_order_item_id: item.salesOrderItemId,
          ordered_quantity: item.orderedQuantity,
        }))
      );
      if (itemsError) {
        await this.supabase.from("deliveries").delete().eq("id", deliveryId);
        throw new Error(`createDelivery items failed: ${itemsError.message}`);
      }
    }

    const created = await this.getDelivery(deliveryId);
    if (!created) throw new Error("createDelivery: delivery not found after insert");
    return created;
  }

  async getDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    const { data } = await this.supabase
      .from("deliveries")
      .select(
        "id, company_id, sales_order_id, attempt_number, assigned_driver_id, status, " +
          "items:delivery_items(id, sales_order_item_id, ordered_quantity, dispatched_quantity, received_quantity, rejected_quantity, returned_quantity, unresolved_quantity, sales_order_item:sales_order_items!sales_order_item_id(unit_price, unit, product_name_raw, product:products!product_id(name))), " +
          "exceptions:delivery_exceptions(id, reason_code, note, severity, resolution_status, actor_id, created_at, delivery_item_id), " +
          "evidence:delivery_evidence(id, evidence_type, storage_ref, captured_at, latitude, longitude, actor_id, metadata, delivery_item_id), " +
          "recipient:delivery_recipients(recipient_name, identity_note, is_expected_pic, signature_evidence_id)"
      )
      .eq("id", deliveryId)
      .maybeSingle();

    if (!data) return null;
    return mapDeliveryRow(data);
  }

  async getLatestDeliveryForOrder(salesOrderId: string): Promise<DeliveryRecord | null> {
    const { data } = await this.supabase
      .from("deliveries")
      .select("id")
      .eq("sales_order_id", salesOrderId)
      .order("attempt_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return this.getDelivery((data as { id: string }).id);
  }

  async assignDriver(deliveryId: string, driverId: string): Promise<void> {
    await this.supabase.from("deliveries").update({ assigned_driver_id: driverId }).eq("id", deliveryId);
  }

  async syncSalesOrderStatus(salesOrderId: string): Promise<string | null> {
    const { data, error } = await this.supabase.rpc("sync_sales_order_delivery_status", {
      p_sales_order_id: salesOrderId,
    });
    if (error) throw new Error(`syncSalesOrderStatus failed: ${error.message}`);
    return (data as string | null) ?? null;
  }

  async recordDispatch(deliveryId: string): Promise<void> {
    const { data } = await this.supabase
      .from("delivery_items")
      .select("id, ordered_quantity")
      .eq("delivery_id", deliveryId);
    for (const item of (data ?? []) as { id: string; ordered_quantity: number }[]) {
      await this.supabase
        .from("delivery_items")
        .update({ dispatched_quantity: item.ordered_quantity })
        .eq("id", item.id);
    }
    await this.supabase
      .from("deliveries")
      .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
      .eq("id", deliveryId)
      .eq("status", "planned");
  }

  async recordArrival(deliveryId: string): Promise<void> {
    await this.supabase
      .from("deliveries")
      .update({ status: "arrived", arrived_at: new Date().toISOString() })
      .eq("id", deliveryId)
      .eq("status", "dispatched");
  }

  async updateItemOutcome(
    deliveryItemId: string,
    patch: Partial<{
      receivedQuantity: number;
      rejectedQuantity: number;
      returnedQuantity: number;
      unresolvedQuantity: number;
    }>
  ): Promise<void> {
    const update: Record<string, number> = {};
    if (patch.receivedQuantity !== undefined) update.received_quantity = patch.receivedQuantity;
    if (patch.rejectedQuantity !== undefined) update.rejected_quantity = patch.rejectedQuantity;
    if (patch.returnedQuantity !== undefined) update.returned_quantity = patch.returnedQuantity;
    if (patch.unresolvedQuantity !== undefined) update.unresolved_quantity = patch.unresolvedQuantity;
    if (Object.keys(update).length === 0) return;
    const { error } = await this.supabase.from("delivery_items").update(update).eq("id", deliveryItemId);
    if (error) throw new Error(`updateItemOutcome failed: ${error.message}`);
  }

  async finalizeDelivery(
    deliveryId: string,
    finalStatus: DeliveryStatus
  ): Promise<{ delivery: DeliveryRecord; alreadyFinalized: boolean }> {
    const existing = await this.getDelivery(deliveryId);
    if (!existing) throw new Error("finalizeDelivery: delivery not found");

    const terminal: DeliveryStatus[] = [
      "fully_received",
      "partially_received",
      "rejected",
      "store_closed",
      "failed",
      "verified",
    ];
    if (terminal.includes(existing.status)) {
      return { delivery: existing, alreadyFinalized: true };
    }

    await this.supabase
      .from("deliveries")
      .update({ status: finalStatus, finalized_at: new Date().toISOString() })
      .eq("id", deliveryId)
      .eq("status", existing.status);

    const updated = await this.getDelivery(deliveryId);
    return { delivery: updated ?? { ...existing, status: finalStatus }, alreadyFinalized: false };
  }

  async insertException(
    companyId: string,
    deliveryId: string,
    input: DeliveryExceptionInput,
    actorId: string | null
  ): Promise<DeliveryExceptionRecord> {
    const { data, error } = await this.supabase
      .from("delivery_exceptions")
      .insert({
        company_id: companyId,
        delivery_id: deliveryId,
        delivery_item_id: input.deliveryItemId ?? null,
        reason_code: input.reasonCode,
        note: input.note ?? null,
        severity: input.severity,
        actor_id: actorId,
      })
      .select("id, reason_code, note, severity, resolution_status, actor_id, created_at, delivery_item_id")
      .single();
    if (error) throw new Error(`insertException failed: ${error.message}`);
    const row = data as {
      id: string;
      reason_code: string;
      note: string | null;
      severity: string;
      resolution_status: string;
      actor_id: string | null;
      created_at: string;
      delivery_item_id: string | null;
    };
    return {
      id: row.id,
      reasonCode: row.reason_code as DeliveryExceptionInput["reasonCode"],
      note: row.note,
      severity: row.severity as ExceptionSeverity,
      resolutionStatus: row.resolution_status as DeliveryExceptionRecord["resolutionStatus"],
      actorId: row.actor_id,
      createdAt: row.created_at,
      deliveryItemId: row.delivery_item_id,
    };
  }

  async insertEvidence(
    companyId: string,
    deliveryId: string,
    input: DeliveryEvidenceInput,
    actorId: string | null
  ): Promise<DeliveryEvidenceRecord> {
    const { data, error } = await this.supabase
      .from("delivery_evidence")
      .insert({
        company_id: companyId,
        delivery_id: deliveryId,
        delivery_item_id: input.deliveryItemId ?? null,
        evidence_type: input.evidenceType,
        storage_ref: input.storageRef,
        captured_at: input.capturedAt ?? new Date().toISOString(),
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        actor_id: actorId,
        metadata: input.metadata ?? {},
      })
      .select("id, evidence_type, storage_ref, captured_at, latitude, longitude, actor_id, metadata, delivery_item_id")
      .single();
    if (error) throw new Error(`insertEvidence failed: ${error.message}`);
    const row = data as {
      id: string;
      evidence_type: string;
      storage_ref: string;
      captured_at: string;
      latitude: number | null;
      longitude: number | null;
      actor_id: string | null;
      metadata: Record<string, unknown>;
      delivery_item_id: string | null;
    };
    return {
      id: row.id,
      evidenceType: row.evidence_type as DeliveryEvidenceInput["evidenceType"],
      storageRef: row.storage_ref,
      capturedAt: row.captured_at,
      latitude: row.latitude,
      longitude: row.longitude,
      actorId: row.actor_id,
      metadata: row.metadata,
      deliveryItemId: row.delivery_item_id,
    };
  }

  async insertRecipient(companyId: string, deliveryId: string, input: RecipientInput): Promise<void> {
    const { error } = await this.supabase.from("delivery_recipients").insert({
      company_id: companyId,
      delivery_id: deliveryId,
      recipient_name: input.recipientName,
      identity_note: input.identityNote ?? null,
      is_expected_pic: input.isExpectedPic,
      signature_evidence_id: input.signatureEvidenceId ?? null,
    });
    if (error) throw new Error(`insertRecipient failed: ${error.message}`);
  }

  async getPreviousRecipientName(salesOrderId: string, beforeAttemptNumber: number): Promise<string | null> {
    const { data } = await this.supabase
      .from("deliveries")
      .select("id, recipient:delivery_recipients(recipient_name)")
      .eq("sales_order_id", salesOrderId)
      .lt("attempt_number", beforeAttemptNumber)
      .order("attempt_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const row = data as unknown as { recipient: { recipient_name: string }[] | null };
    return row.recipient?.[0]?.recipient_name ?? null;
  }

  async insertEvent(input: DeliveryEventInput): Promise<void> {
    await this.supabase.from("delivery_events").insert({
      company_id: input.companyId,
      delivery_id: input.deliveryId,
      event_type: input.eventType,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      actor_id: input.actorId,
      telegram_update_event_id: input.telegramUpdateEventId,
      payload: input.payload,
    });
  }

  async getConversationState(identityId: string): Promise<DeliveryConversationState> {
    const { data } = await this.supabase
      .from("delivery_conversation_state")
      .select("pending_delivery_id, awaiting, current_item_index, draft_state")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();

    if (!data) return { pendingDeliveryId: null, awaiting: "none", currentItemIndex: 0, draftState: {} };
    const row = data as {
      pending_delivery_id: string | null;
      awaiting: DeliveryConversationAwaiting;
      current_item_index: number;
      draft_state: Record<string, unknown>;
    };
    return {
      pendingDeliveryId: row.pending_delivery_id,
      awaiting: row.awaiting,
      currentItemIndex: row.current_item_index,
      draftState: row.draft_state,
    };
  }

  async setConversationState(identityId: string, companyId: string, state: DeliveryConversationState): Promise<void> {
    await this.supabase.from("delivery_conversation_state").upsert(
      {
        telegram_identity_id: identityId,
        company_id: companyId,
        pending_delivery_id: state.pendingDeliveryId,
        awaiting: state.awaiting,
        current_item_index: state.currentItemIndex,
        draft_state: state.draftState,
      },
      { onConflict: "telegram_identity_id" }
    );
  }

  async insertOwnerAlert(input: OwnerAlertInsertInput): Promise<{ id: string }> {
    const { data, error } = await this.supabase
      .from("owner_alerts")
      .insert({
        company_id: input.companyId,
        sales_order_id: input.salesOrderId,
        delivery_id: input.deliveryId,
        alert_type: input.alertType,
        channel: input.channel,
        severity: input.severity,
        payload: input.payload,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw new Error(`insertOwnerAlert failed: ${error.message}`);
    return { id: (data as { id: string }).id };
  }
}

function mapDeliveryRow(data: unknown): DeliveryRecord {
  const row = data as {
    id: string;
    company_id: string;
    sales_order_id: string;
    attempt_number: number;
    assigned_driver_id: string | null;
    status: DeliveryStatus;
    items: {
      id: string;
      sales_order_item_id: string;
      ordered_quantity: number;
      dispatched_quantity: number;
      received_quantity: number;
      rejected_quantity: number;
      returned_quantity: number;
      unresolved_quantity: number;
      sales_order_item: { unit_price: number; unit: string | null; product_name_raw: string | null; product: { name: string } | null } | null;
    }[];
    exceptions: {
      id: string;
      reason_code: string;
      note: string | null;
      severity: string;
      resolution_status: string;
      actor_id: string | null;
      created_at: string;
      delivery_item_id: string | null;
    }[];
    evidence: {
      id: string;
      evidence_type: string;
      storage_ref: string;
      captured_at: string;
      latitude: number | null;
      longitude: number | null;
      actor_id: string | null;
      metadata: Record<string, unknown>;
      delivery_item_id: string | null;
    }[];
    recipient: { recipient_name: string; identity_note: string | null; is_expected_pic: boolean; signature_evidence_id: string | null }[] | null;
  };

  const items: DeliveryItemRecord[] = row.items.map((i) => ({
    id: i.id,
    salesOrderItemId: i.sales_order_item_id,
    productName: i.sales_order_item?.product?.name ?? i.sales_order_item?.product_name_raw ?? "(produk)",
    unit: i.sales_order_item?.unit ?? null,
    unitPrice: i.sales_order_item?.unit_price ?? 0,
    orderedQuantity: i.ordered_quantity,
    dispatchedQuantity: i.dispatched_quantity,
    receivedQuantity: i.received_quantity,
    rejectedQuantity: i.rejected_quantity,
    returnedQuantity: i.returned_quantity,
    unresolvedQuantity: i.unresolved_quantity,
  }));

  const recipientRow = row.recipient?.[0];

  return {
    id: row.id,
    companyId: row.company_id,
    salesOrderId: row.sales_order_id,
    attemptNumber: row.attempt_number,
    assignedDriverId: row.assigned_driver_id,
    status: row.status,
    items,
    exceptions: row.exceptions.map((e) => ({
      id: e.id,
      reasonCode: e.reason_code as DeliveryExceptionInput["reasonCode"],
      note: e.note,
      severity: e.severity as ExceptionSeverity,
      resolutionStatus: e.resolution_status as DeliveryExceptionRecord["resolutionStatus"],
      actorId: e.actor_id,
      createdAt: e.created_at,
      deliveryItemId: e.delivery_item_id,
    })),
    evidence: row.evidence.map((e) => ({
      id: e.id,
      evidenceType: e.evidence_type as DeliveryEvidenceInput["evidenceType"],
      storageRef: e.storage_ref,
      capturedAt: e.captured_at,
      latitude: e.latitude,
      longitude: e.longitude,
      actorId: e.actor_id,
      metadata: e.metadata,
      deliveryItemId: e.delivery_item_id,
    })),
    recipient: recipientRow
      ? {
          recipientName: recipientRow.recipient_name,
          identityNote: recipientRow.identity_note,
          isExpectedPic: recipientRow.is_expected_pic,
          signatureEvidenceId: recipientRow.signature_evidence_id,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation — untuk test.
// ---------------------------------------------------------------------------

export class InMemoryDeliveryRepository implements DeliveryRepositoryInterface {
  confirmedOrders = new Map<string, ConfirmedOrderSnapshot>();
  private deliveries = new Map<string, DeliveryRecord>();
  private idempotencyIndex = new Map<string, string>(); // `${companyId}:${key}` -> deliveryId
  private conversationStates = new Map<string, DeliveryConversationState>();
  public events: DeliveryEventInput[] = [];
  public ownerAlerts: (OwnerAlertInsertInput & { id: string; status: "pending" | "sent" | "failed" })[] = [];
  private seq = 0;

  seedConfirmedOrder(order: ConfirmedOrderSnapshot): void {
    this.confirmedOrders.set(order.id, order);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async getConfirmedOrder(salesOrderId: string, companyId: string): Promise<ConfirmedOrderSnapshot | null> {
    const order = this.confirmedOrders.get(salesOrderId);
    if (!order || order.companyId !== companyId) return null;
    return order;
  }

  async findDeliveryByIdempotencyKey(companyId: string, idempotencyKey: string): Promise<DeliveryRecord | null> {
    const id = this.idempotencyIndex.get(`${companyId}:${idempotencyKey}`);
    return id ? (this.deliveries.get(id) ?? null) : null;
  }

  async createDelivery(input: {
    companyId: string;
    salesOrderId: string;
    idempotencyKey: string | null;
    createdBy: string | null;
    items: { salesOrderItemId: string; productName: string; unit: string | null; unitPrice: number; orderedQuantity: number }[];
  }): Promise<DeliveryRecord> {
    const attemptNumber =
      [...this.deliveries.values()].filter((d) => d.salesOrderId === input.salesOrderId).length + 1;
    const id = this.nextId("delivery");
    const record: DeliveryRecord = {
      id,
      companyId: input.companyId,
      salesOrderId: input.salesOrderId,
      attemptNumber,
      assignedDriverId: null,
      status: "planned",
      items: input.items.map((item) => ({
        id: this.nextId("ditem"),
        salesOrderItemId: item.salesOrderItemId,
        productName: item.productName,
        unit: item.unit,
        unitPrice: item.unitPrice,
        orderedQuantity: item.orderedQuantity,
        dispatchedQuantity: 0,
        receivedQuantity: 0,
        rejectedQuantity: 0,
        returnedQuantity: 0,
        unresolvedQuantity: 0,
      })),
      exceptions: [],
      evidence: [],
      recipient: null,
    };
    this.deliveries.set(id, record);
    if (input.idempotencyKey) {
      this.idempotencyIndex.set(`${input.companyId}:${input.idempotencyKey}`, id);
    }
    return record;
  }

  async getDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    return this.deliveries.get(deliveryId) ?? null;
  }

  async getLatestDeliveryForOrder(salesOrderId: string): Promise<DeliveryRecord | null> {
    const matches = [...this.deliveries.values()]
      .filter((d) => d.salesOrderId === salesOrderId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
    return matches[0] ?? null;
  }

  async assignDriver(deliveryId: string, driverId: string): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (d) d.assignedDriverId = driverId;
  }

  /**
   * Mirror logika `sync_sales_order_delivery_status` (migration) secara
   * fungsional: idempoten, dihitung ulang dari sumber kebenaran (bukan
   * increment). In-memory tidak punya row lock sungguhan, tapi karena
   * JS single-threaded, tidak ada race condition untuk direplikasi di sini.
   */
  async syncSalesOrderStatus(salesOrderId: string): Promise<string | null> {
    const order = this.confirmedOrders.get(salesOrderId);
    if (!order) return null;
    if (!["confirmed", "delivering"].includes(order.status)) return order.status;

    const receivedByItem = new Map<string, number>();
    for (const d of this.deliveries.values()) {
      if (d.salesOrderId !== salesOrderId) continue;
      for (const item of d.items) {
        receivedByItem.set(item.salesOrderItemId, (receivedByItem.get(item.salesOrderItemId) ?? 0) + item.receivedQuantity);
      }
    }
    const fullyCovered = order.items.every((i) => (receivedByItem.get(i.id) ?? 0) >= i.quantity);

    if (fullyCovered) {
      order.status = "delivered";
    } else if (order.status === "confirmed") {
      order.status = "delivering";
    }
    return order.status;
  }

  async recordDispatch(deliveryId: string): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (!d || d.status !== "planned") return;
    for (const item of d.items) item.dispatchedQuantity = item.orderedQuantity;
    d.status = "dispatched";
  }

  async recordArrival(deliveryId: string): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (!d || d.status !== "dispatched") return;
    d.status = "arrived";
  }

  async updateItemOutcome(
    deliveryItemId: string,
    patch: Partial<{
      receivedQuantity: number;
      rejectedQuantity: number;
      returnedQuantity: number;
      unresolvedQuantity: number;
    }>
  ): Promise<void> {
    for (const d of this.deliveries.values()) {
      const item = d.items.find((i) => i.id === deliveryItemId);
      if (item) {
        if (patch.receivedQuantity !== undefined) item.receivedQuantity = patch.receivedQuantity;
        if (patch.rejectedQuantity !== undefined) item.rejectedQuantity = patch.rejectedQuantity;
        if (patch.returnedQuantity !== undefined) item.returnedQuantity = patch.returnedQuantity;
        if (patch.unresolvedQuantity !== undefined) item.unresolvedQuantity = patch.unresolvedQuantity;
        return;
      }
    }
  }

  async finalizeDelivery(
    deliveryId: string,
    finalStatus: DeliveryStatus
  ): Promise<{ delivery: DeliveryRecord; alreadyFinalized: boolean }> {
    const d = this.deliveries.get(deliveryId);
    if (!d) throw new Error("finalizeDelivery: delivery not found");
    const terminal: DeliveryStatus[] = [
      "fully_received",
      "partially_received",
      "rejected",
      "store_closed",
      "failed",
      "verified",
    ];
    if (terminal.includes(d.status)) {
      return { delivery: d, alreadyFinalized: true };
    }
    d.status = finalStatus;
    return { delivery: d, alreadyFinalized: false };
  }

  async insertException(
    companyId: string,
    deliveryId: string,
    input: DeliveryExceptionInput,
    actorId: string | null
  ): Promise<DeliveryExceptionRecord> {
    const record: DeliveryExceptionRecord = {
      id: this.nextId("exc"),
      reasonCode: input.reasonCode,
      note: input.note ?? null,
      severity: input.severity,
      resolutionStatus: "open",
      actorId,
      createdAt: new Date().toISOString(),
      deliveryItemId: input.deliveryItemId ?? null,
    };
    const d = this.deliveries.get(deliveryId);
    if (d) d.exceptions.push(record);
    return record;
  }

  async insertEvidence(
    companyId: string,
    deliveryId: string,
    input: DeliveryEvidenceInput,
    actorId: string | null
  ): Promise<DeliveryEvidenceRecord> {
    const record: DeliveryEvidenceRecord = {
      id: this.nextId("evd"),
      evidenceType: input.evidenceType,
      storageRef: input.storageRef,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      actorId,
      metadata: input.metadata ?? {},
      deliveryItemId: input.deliveryItemId ?? null,
    };
    const d = this.deliveries.get(deliveryId);
    if (d) d.evidence.push(record);
    return record;
  }

  async insertRecipient(companyId: string, deliveryId: string, input: RecipientInput): Promise<void> {
    const d = this.deliveries.get(deliveryId);
    if (d) d.recipient = input;
  }

  async insertEvent(input: DeliveryEventInput): Promise<void> {
    this.events.push(input);
  }

  async getPreviousRecipientName(salesOrderId: string, beforeAttemptNumber: number): Promise<string | null> {
    const previous = [...this.deliveries.values()]
      .filter((d) => d.salesOrderId === salesOrderId && d.attemptNumber < beforeAttemptNumber)
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    return previous?.recipient?.recipientName ?? null;
  }

  async getConversationState(identityId: string): Promise<DeliveryConversationState> {
    return (
      this.conversationStates.get(identityId) ?? {
        pendingDeliveryId: null,
        awaiting: "none",
        currentItemIndex: 0,
        draftState: {},
      }
    );
  }

  async setConversationState(identityId: string, _companyId: string, state: DeliveryConversationState): Promise<void> {
    this.conversationStates.set(identityId, state);
  }

  async insertOwnerAlert(input: OwnerAlertInsertInput): Promise<{ id: string }> {
    const id = this.nextId("alert");
    this.ownerAlerts.push({ ...input, id, status: "pending" });
    return { id };
  }
}
