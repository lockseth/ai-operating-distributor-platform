// =============================================================================
// Repository — abstraksi persistence untuk Telegram Sales Order intake.
//
// Interface ini ada supaya workflow.ts bisa diuji tanpa database (lihat
// InMemorySalesOrderRepository) sekaligus supaya identitas SELALU di-resolve
// lewat mapping internal (telegram_identities), bukan dipercaya dari payload.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricedOrder } from "./types";

export interface ResolvedIdentity {
  identityId: string;
  companyId: string;
  userId: string;
  userFullName: string;
}

export type ConversationAwaiting = "none" | "confirmation" | "correction";

export interface ConversationState {
  pendingOrderId: string | null;
  awaiting: ConversationAwaiting;
}

export type EventProcessingStatus =
  | "received"
  | "processed"
  | "rejected_unregistered"
  | "transcription_pending"
  | "not_order"
  | "error";

export interface PersistedOrder {
  id: string;
  orderNumber: string;
  status: string;
  requiresDiscountReview: boolean;
  priced: PricedOrder;
}

export interface SalesOrderTelegramRepository {
  /** Idempotency: true jika update_id ini SUDAH pernah diproses sebelumnya. */
  findEventByUpdateId(telegramUpdateId: number): Promise<{ id: string } | null>;

  insertEvent(input: {
    telegramUpdateId: number;
    companyId: string | null;
    telegramIdentityId: string | null;
    messageType: "text" | "voice" | "other";
    processingStatus: EventProcessingStatus;
    /**
     * Payload update penuh. WAJIB null untuk processingStatus =
     * "rejected_unregistered" — jangan menyimpan isi pesan dari pengirim
     * yang belum terdaftar, cukup metadata handshake di bawah.
     */
    rawPayload: unknown | null;
    /** Metadata handshake minimum — hanya relevan untuk rejected_unregistered. */
    telegramChatId?: number;
    telegramUserId?: number | null;
    telegramUsername?: string | null;
    rejectionReason?: string;
  }): Promise<{ id: string }>;

  updateEventStatus(
    eventId: string,
    processingStatus: EventProcessingStatus,
    resultingOrderId?: string | null,
    errorMessage?: string | null
  ): Promise<void>;

  /** Tidak pernah percaya company_id/user_id dari payload — selalu resolve dari sini. */
  resolveIdentity(telegramChatId: number): Promise<ResolvedIdentity | null>;

  getConversationState(identityId: string): Promise<ConversationState>;

  setConversationState(
    identityId: string,
    companyId: string,
    state: ConversationState
  ): Promise<void>;

  createDraftOrder(input: {
    companyId: string;
    salesId: string;
    priced: PricedOrder;
    knowledgeVersion: string;
    extractionConfidence: number;
    missingFields: string[];
    telegramEventId: string;
  }): Promise<PersistedOrder>;

  getOrder(orderId: string): Promise<PersistedOrder | null>;

  /** Dipakai saat sales membalas UBAH lalu mengirim teks koreksi — draft yang SAMA diperbarui. */
  updateDraftOrder(
    orderId: string,
    input: {
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
    }
  ): Promise<PersistedOrder>;

  /** Idempotent: memanggil ulang pada order yang sudah confirmed tidak membuat perubahan. */
  confirmOrder(orderId: string): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }>;
}

// ---------------------------------------------------------------------------
// Supabase-backed implementation
// ---------------------------------------------------------------------------

export class SupabaseSalesOrderRepository implements SalesOrderTelegramRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async findEventByUpdateId(telegramUpdateId: number): Promise<{ id: string } | null> {
    const { data } = await this.supabase
      .from("telegram_update_events")
      .select("id")
      .eq("telegram_update_id", telegramUpdateId)
      .maybeSingle();
    return (data as { id: string } | null) ?? null;
  }

  async insertEvent(input: {
    telegramUpdateId: number;
    companyId: string | null;
    telegramIdentityId: string | null;
    messageType: "text" | "voice" | "other";
    processingStatus: EventProcessingStatus;
    rawPayload: unknown | null;
    telegramChatId?: number;
    telegramUserId?: number | null;
    telegramUsername?: string | null;
    rejectionReason?: string;
  }): Promise<{ id: string }> {
    const { data, error } = await this.supabase
      .from("telegram_update_events")
      .insert({
        telegram_update_id: input.telegramUpdateId,
        company_id: input.companyId,
        telegram_identity_id: input.telegramIdentityId,
        message_type: input.messageType,
        processing_status: input.processingStatus,
        raw_payload: input.rawPayload,
        telegram_chat_id: input.telegramChatId ?? null,
        telegram_user_id: input.telegramUserId ?? null,
        telegram_username: input.telegramUsername ?? null,
        rejection_reason: input.rejectionReason ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`insertEvent failed: ${error.message}`);
    return data as { id: string };
  }

  async updateEventStatus(
    eventId: string,
    processingStatus: EventProcessingStatus,
    resultingOrderId?: string | null,
    errorMessage?: string | null
  ): Promise<void> {
    await this.supabase
      .from("telegram_update_events")
      .update({
        processing_status: processingStatus,
        resulting_order_id: resultingOrderId ?? null,
        error_message: errorMessage ?? null,
      })
      .eq("id", eventId);
  }

  async resolveIdentity(telegramChatId: number): Promise<ResolvedIdentity | null> {
    const { data } = await this.supabase
      .from("telegram_identities")
      .select("id, company_id, user_id, is_active, user:users!user_id(full_name)")
      .eq("telegram_chat_id", telegramChatId)
      .eq("is_active", true)
      .maybeSingle();

    if (!data) return null;
    const row = data as unknown as {
      id: string;
      company_id: string;
      user_id: string;
      user: { full_name: string } | null;
    };
    return {
      identityId: row.id,
      companyId: row.company_id,
      userId: row.user_id,
      userFullName: row.user?.full_name ?? "Sales",
    };
  }

  async getConversationState(identityId: string): Promise<ConversationState> {
    const { data } = await this.supabase
      .from("telegram_conversation_state")
      .select("pending_order_id, awaiting")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();

    if (!data) return { pendingOrderId: null, awaiting: "none" };
    const row = data as { pending_order_id: string | null; awaiting: ConversationAwaiting };
    return { pendingOrderId: row.pending_order_id, awaiting: row.awaiting };
  }

  async setConversationState(
    identityId: string,
    companyId: string,
    state: ConversationState
  ): Promise<void> {
    await this.supabase.from("telegram_conversation_state").upsert(
      {
        telegram_identity_id: identityId,
        company_id: companyId,
        pending_order_id: state.pendingOrderId,
        awaiting: state.awaiting,
      },
      { onConflict: "telegram_identity_id" }
    );
  }

  private async generateOrderNumber(companyId: string): Promise<string> {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `SO-${yy}${mm}-`;

    const { data } = await this.supabase
      .from("sales_orders")
      .select("order_number")
      .eq("company_id", companyId)
      .like("order_number", `${prefix}%`)
      .order("order_number", { ascending: false })
      .limit(1);

    const lastSeq = (data?.[0] as { order_number: string } | undefined)?.order_number?.replace(prefix, "") ?? "0000";
    const nextSeq = String(parseInt(lastSeq, 10) + 1).padStart(4, "0");
    return `${prefix}${nextSeq}`;
  }

  async createDraftOrder(input: {
    companyId: string;
    salesId: string;
    priced: PricedOrder;
    knowledgeVersion: string;
    extractionConfidence: number;
    missingFields: string[];
    telegramEventId: string;
  }): Promise<PersistedOrder> {
    const orderNumber = await this.generateOrderNumber(input.companyId);
    const { priced } = input;

    const { data: orderRow, error: orderError } = await this.supabase
      .from("sales_orders")
      .insert({
        company_id: input.companyId,
        order_number: orderNumber,
        customer_id: priced.customerId,
        customer_name_raw: priced.customerId ? null : priced.customerName,
        sales_id: input.salesId,
        status: "draft",
        source_channel: "telegram",
        knowledge_version: input.knowledgeVersion,
        extraction_confidence: input.extractionConfidence,
        missing_fields: input.missingFields,
        requires_discount_review: priced.requiresDiscountReview,
        delivery_note: priced.deliveryNote,
        telegram_update_event_id: input.telegramEventId,
        total_amount: priced.subtotal,
        discount_amount: priced.totalDiscount,
        tax_amount: 0,
        final_amount: priced.estimatedTotal,
        created_by: input.salesId,
      })
      .select("id")
      .single();

    if (orderError) throw new Error(`createDraftOrder failed: ${orderError.message}`);
    const orderId = (orderRow as { id: string }).id;

    if (priced.items.length > 0) {
      const { error: itemsError } = await this.supabase.from("sales_order_items").insert(
        priced.items.map((item) => ({
          order_id: orderId,
          product_id: item.productId,
          product_name_raw: item.productId ? null : item.productName,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unitPrice,
          discount_type: item.discountType,
          discount_value: item.discountValue,
          amount_before_discount: item.amountBeforeDiscount,
          discount_amount: item.amountBeforeDiscount - item.amountAfterDiscount,
          discount_exception: item.discountException,
          total_amount: item.amountAfterDiscount,
        }))
      );
      if (itemsError) {
        await this.supabase.from("sales_orders").delete().eq("id", orderId);
        throw new Error(`createDraftOrder items failed: ${itemsError.message}`);
      }
    }

    return {
      id: orderId,
      orderNumber,
      status: "draft",
      requiresDiscountReview: priced.requiresDiscountReview,
      priced,
    };
  }

  async updateDraftOrder(
    orderId: string,
    input: {
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
    }
  ): Promise<PersistedOrder> {
    const { priced } = input;

    const { error: updateError } = await this.supabase
      .from("sales_orders")
      .update({
        customer_id: priced.customerId,
        customer_name_raw: priced.customerId ? null : priced.customerName,
        knowledge_version: input.knowledgeVersion,
        extraction_confidence: input.extractionConfidence,
        missing_fields: input.missingFields,
        requires_discount_review: priced.requiresDiscountReview,
        delivery_note: priced.deliveryNote,
        total_amount: priced.subtotal,
        discount_amount: priced.totalDiscount,
        final_amount: priced.estimatedTotal,
      })
      .eq("id", orderId)
      .eq("status", "draft"); // guard: hanya order yang masih draft yang boleh dikoreksi

    if (updateError) throw new Error(`updateDraftOrder failed: ${updateError.message}`);

    await this.supabase.from("sales_order_items").delete().eq("order_id", orderId);

    if (priced.items.length > 0) {
      const { error: itemsError } = await this.supabase.from("sales_order_items").insert(
        priced.items.map((item) => ({
          order_id: orderId,
          product_id: item.productId,
          product_name_raw: item.productId ? null : item.productName,
          quantity: item.quantity,
          unit: item.unit,
          unit_price: item.unitPrice,
          discount_type: item.discountType,
          discount_value: item.discountValue,
          amount_before_discount: item.amountBeforeDiscount,
          discount_amount: item.amountBeforeDiscount - item.amountAfterDiscount,
          discount_exception: item.discountException,
          total_amount: item.amountAfterDiscount,
        }))
      );
      if (itemsError) throw new Error(`updateDraftOrder items failed: ${itemsError.message}`);
    }

    const updated = await this.getOrder(orderId);
    if (!updated) throw new Error("updateDraftOrder: order not found after update");
    return updated;
  }

  async getOrder(orderId: string): Promise<PersistedOrder | null> {
    const { data } = await this.supabase
      .from("sales_orders")
      .select(
        "id, order_number, status, requires_discount_review, customer_name_raw, delivery_note, total_amount, discount_amount, final_amount, customer:customers!customer_id(id, name), items:sales_order_items(product_id, product_name_raw, quantity, unit, unit_price, discount_type, discount_value, amount_before_discount, discount_exception, total_amount)"
      )
      .eq("id", orderId)
      .maybeSingle();

    if (!data) return null;
    const row = data as unknown as {
      id: string;
      order_number: string;
      status: string;
      requires_discount_review: boolean;
      customer_name_raw: string | null;
      delivery_note: string | null;
      total_amount: number;
      discount_amount: number;
      final_amount: number;
      customer: { id: string; name: string } | null;
      items: {
        product_id: string | null;
        product_name_raw: string | null;
        quantity: number;
        unit: string | null;
        unit_price: number;
        discount_type: "percentage" | "nominal" | null;
        discount_value: number | null;
        amount_before_discount: number;
        discount_exception: boolean;
        total_amount: number;
      }[];
    };

    const priced: PricedOrder = {
      customerName: row.customer?.name ?? row.customer_name_raw,
      customerId: row.customer?.id ?? null,
      items: row.items.map((i) => ({
        productName: i.product_name_raw ?? "(produk)",
        productCode: null,
        productId: i.product_id,
        quantity: i.quantity,
        unit: i.unit,
        unitPrice: i.unit_price,
        discountType: i.discount_type,
        discountValue: i.discount_value,
        amountBeforeDiscount: i.amount_before_discount ?? i.quantity * i.unit_price,
        amountAfterDiscount: i.total_amount,
        discountException: i.discount_exception,
        requiresReview: false,
      })),
      subtotal: row.total_amount,
      totalDiscount: row.discount_amount,
      estimatedTotal: row.final_amount,
      requiresDiscountReview: row.requires_discount_review,
      deliveryNote: row.delivery_note,
    };

    return {
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      requiresDiscountReview: row.requires_discount_review,
      priced,
    };
  }

  async confirmOrder(orderId: string): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }> {
    const existing = await this.getOrder(orderId);
    if (!existing) throw new Error("Order not found");

    if (existing.status === "confirmed") {
      return { order: existing, alreadyConfirmed: true };
    }

    await this.supabase
      .from("sales_orders")
      .update({ status: "confirmed" })
      .eq("id", orderId)
      .eq("status", "draft"); // guard: hanya transisi dari draft, mencegah race/duplikasi

    const updated = await this.getOrder(orderId);
    return { order: updated ?? { ...existing, status: "confirmed" }, alreadyConfirmed: false };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation — untuk test (mencakup seluruh skenario DoD
// tanpa memerlukan Supabase hidup).
// ---------------------------------------------------------------------------

export interface InMemoryEventRecord {
  id: string;
  status: EventProcessingStatus;
  rawPayload: unknown | null;
  telegramChatId?: number;
  telegramUserId?: number | null;
  telegramUsername?: string | null;
  rejectionReason?: string;
}

export class InMemorySalesOrderRepository implements SalesOrderTelegramRepository {
  private events = new Map<number, InMemoryEventRecord>();
  private identities = new Map<number, ResolvedIdentity>();
  private conversationStates = new Map<string, ConversationState>();
  private orders = new Map<string, PersistedOrder>();
  private seq = 0;

  seedIdentity(telegramChatId: number, identity: ResolvedIdentity): void {
    this.identities.set(telegramChatId, identity);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async findEventByUpdateId(telegramUpdateId: number): Promise<{ id: string } | null> {
    const e = this.events.get(telegramUpdateId);
    return e ? { id: e.id } : null;
  }

  async insertEvent(input: {
    telegramUpdateId: number;
    companyId: string | null;
    telegramIdentityId: string | null;
    messageType: "text" | "voice" | "other";
    processingStatus: EventProcessingStatus;
    rawPayload: unknown | null;
    telegramChatId?: number;
    telegramUserId?: number | null;
    telegramUsername?: string | null;
    rejectionReason?: string;
  }): Promise<{ id: string }> {
    const id = this.nextId("evt");
    this.events.set(input.telegramUpdateId, {
      id,
      status: input.processingStatus,
      rawPayload: input.rawPayload,
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
      rejectionReason: input.rejectionReason,
    });
    return { id };
  }

  async updateEventStatus(eventId: string, processingStatus: EventProcessingStatus): Promise<void> {
    for (const [updateId, e] of this.events) {
      if (e.id === eventId) this.events.set(updateId, { ...e, status: processingStatus });
    }
  }

  /** Test-only helper: inspeksi baris event mentah (mis. verifikasi rawPayload tidak tersimpan). */
  getEventRecord(telegramUpdateId: number): InMemoryEventRecord | undefined {
    return this.events.get(telegramUpdateId);
  }

  async resolveIdentity(telegramChatId: number): Promise<ResolvedIdentity | null> {
    return this.identities.get(telegramChatId) ?? null;
  }

  async getConversationState(identityId: string): Promise<ConversationState> {
    return this.conversationStates.get(identityId) ?? { pendingOrderId: null, awaiting: "none" };
  }

  async setConversationState(identityId: string, _companyId: string, state: ConversationState): Promise<void> {
    this.conversationStates.set(identityId, state);
  }

  async createDraftOrder(input: {
    companyId: string;
    salesId: string;
    priced: PricedOrder;
    knowledgeVersion: string;
    extractionConfidence: number;
    missingFields: string[];
    telegramEventId: string;
  }): Promise<PersistedOrder> {
    const id = this.nextId("order");
    const orderNumber = `SO-TEST-${this.seq}`;
    const order: PersistedOrder = {
      id,
      orderNumber,
      status: "draft",
      requiresDiscountReview: input.priced.requiresDiscountReview,
      priced: input.priced,
    };
    this.orders.set(id, order);
    return order;
  }

  async getOrder(orderId: string): Promise<PersistedOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async updateDraftOrder(
    orderId: string,
    input: {
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
    }
  ): Promise<PersistedOrder> {
    const existing = this.orders.get(orderId);
    if (!existing) throw new Error("Order not found");
    if (existing.status !== "draft") return existing; // guard, no-op

    const updated: PersistedOrder = {
      ...existing,
      requiresDiscountReview: input.priced.requiresDiscountReview,
      priced: input.priced,
    };
    this.orders.set(orderId, updated);
    return updated;
  }

  async confirmOrder(orderId: string): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }> {
    const existing = this.orders.get(orderId);
    if (!existing) throw new Error("Order not found");
    if (existing.status === "confirmed") {
      return { order: existing, alreadyConfirmed: true };
    }
    const updated: PersistedOrder = { ...existing, status: "confirmed" };
    this.orders.set(orderId, updated);
    return { order: updated, alreadyConfirmed: false };
  }
}
