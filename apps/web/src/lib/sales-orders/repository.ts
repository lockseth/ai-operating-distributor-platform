// =============================================================================
// Repository — abstraksi persistence untuk Telegram Sales Order intake.
//
// Interface ini ada supaya workflow.ts bisa diuji tanpa database (lihat
// InMemorySalesOrderRepository) sekaligus supaya identitas SELALU di-resolve
// lewat mapping internal (telegram_identities), bukan dipercaya dari payload.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricedOrder } from "./types";
import type { OrderSource } from "./order-source";
import { hasTelegramCapability } from "@/lib/telegram-enrollment/capability";

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
  orderSource: OrderSource;
}

/**
 * Gate 3E-B: alasan draft order ditolak SEBELUM tersimpan (customer/produk
 * tidak valid untuk tenant ini, atau quantity ilegal). Dilempar oleh
 * createDraftOrder/updateDraftOrder — TIDAK PERNAH menulis order parsial,
 * baik lewat RPC atomic (Supabase) maupun fake in-memory (lihat
 * validateDraftInput di bawah, method yang sama dipakai kedua path).
 */
export type DraftOrderRejectionCode =
  | "invalid_customer"
  | "invalid_product"
  | "invalid_quantity"
  | "forbidden";

export class DraftOrderRejectedError extends Error {
  constructor(
    public readonly code: DraftOrderRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "DraftOrderRejectedError";
  }
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
    errorMessage?: string | null,
  ): Promise<void>;

  /** Tidak pernah percaya company_id/user_id dari payload — selalu resolve dari sini. */
  resolveIdentity(telegramChatId: number): Promise<ResolvedIdentity | null>;

  /**
   * Gate 3E-D1-R1: pairing (telegram_identities aktif) TIDAK LAGI berarti
   * eligible untuk workflow Sales Order/Delivery/Dispute/Menu -- sejak
   * pairing digeneralisasi ke {owner, admin, sales}, hanya role 'sales' yang
   * punya capability 'sales.order.telegram'. Dicek ulang di sini (bukan
   * disimpulkan dari resolveIdentity) supaya perubahan role user setelah
   * pairing langsung fail-closed pada request berikutnya.
   */
  hasSalesOrderCapability(userId: string, companyId: string): Promise<boolean>;

  getConversationState(identityId: string): Promise<ConversationState>;

  setConversationState(
    identityId: string,
    companyId: string,
    state: ConversationState,
  ): Promise<void>;

  createDraftOrder(input: {
    companyId: string;
    salesId: string;
    priced: PricedOrder;
    knowledgeVersion: string;
    extractionConfidence: number;
    missingFields: string[];
    telegramEventId: string;
    /** Bagaimana toko menyampaikan pesanan kepada Salesman — bukan channel input sistem. */
    orderSource: OrderSource;
  }): Promise<PersistedOrder>;

  getOrder(orderId: string): Promise<PersistedOrder | null>;

  /** Dipakai saat sales membalas UBAH lalu mengirim teks koreksi — draft yang SAMA diperbarui. */
  updateDraftOrder(
    orderId: string,
    input: {
      companyId: string;
      actorId: string;
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
      orderSource: OrderSource;
    },
  ): Promise<PersistedOrder>;

  /**
   * Idempotent: memanggil ulang pada order yang sudah confirmed tidak membuat
   * perubahan. options.paymentTermsDays -- diisi eksplisit SAAT transisi
   * draft->confirmed ini (sales_orders.payment_terms_days, migration
   * 20260812000003); undefined/null berarti belum diisi (order tetap boleh
   * confirmed, Document Engine yang menolak eksplisit lewat
   * PAYMENT_TERMS_INCOMPLETE saat issuance, bukan confirmOrder). Setelah
   * confirmed, nilai ini immutable lewat trigger DB
   * (prevent_payment_terms_mutation_after_confirmed) -- tidak bisa diubah
   * diam-diam lewat panggilan berikutnya.
   */
  confirmOrder(
    orderId: string,
    companyId: string,
    actorId: string,
    options?: { paymentTermsDays?: number | null },
  ): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }>;
}

function isDraftOrderRejectionCode(
  value: string | undefined,
): value is DraftOrderRejectionCode {
  return (
    value === "invalid_customer" ||
    value === "invalid_product" ||
    value === "invalid_quantity" ||
    value === "forbidden"
  );
}

// ---------------------------------------------------------------------------
// Supabase-backed implementation
// ---------------------------------------------------------------------------

export class SupabaseSalesOrderRepository implements SalesOrderTelegramRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async findEventByUpdateId(
    telegramUpdateId: number,
  ): Promise<{ id: string } | null> {
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
    errorMessage?: string | null,
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

  async resolveIdentity(
    telegramChatId: number,
  ): Promise<ResolvedIdentity | null> {
    const { data } = await this.supabase
      .from("telegram_identities")
      .select(
        "id, company_id, user_id, is_active, user:users!user_id(full_name, company_id, is_active)",
      )
      .eq("telegram_chat_id", telegramChatId)
      .eq("is_active", true)
      .maybeSingle();

    if (!data) return null;
    const row = data as unknown as {
      id: string;
      company_id: string;
      user_id: string;
      user: {
        full_name: string;
        company_id: string;
        is_active: boolean;
      } | null;
    };
    if (
      !row.user ||
      row.user.is_active !== true ||
      row.user.company_id !== row.company_id
    ) {
      return null;
    }
    return {
      identityId: row.id,
      companyId: row.company_id,
      userId: row.user_id,
      userFullName: row.user.full_name,
    };
  }

  async hasSalesOrderCapability(
    userId: string,
    companyId: string,
  ): Promise<boolean> {
    const { data } = await this.supabase
      .from("user_roles")
      .select("role:roles!role_id(name)")
      .eq("user_id", userId)
      .eq("company_id", companyId);

    const roles = ((data ?? []) as unknown as { role: { name: string } | null }[])
      .map((row) => row.role?.name)
      .filter((name): name is string => Boolean(name));

    return hasTelegramCapability(roles, "sales.order.telegram");
  }

  async getConversationState(identityId: string): Promise<ConversationState> {
    const { data } = await this.supabase
      .from("telegram_conversation_state")
      .select("pending_order_id, awaiting")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();

    if (!data) return { pendingOrderId: null, awaiting: "none" };
    const row = data as {
      pending_order_id: string | null;
      awaiting: ConversationAwaiting;
    };
    return { pendingOrderId: row.pending_order_id, awaiting: row.awaiting };
  }

  async setConversationState(
    identityId: string,
    companyId: string,
    state: ConversationState,
  ): Promise<void> {
    await this.supabase.from("telegram_conversation_state").upsert(
      {
        telegram_identity_id: identityId,
        company_id: companyId,
        pending_order_id: state.pendingOrderId,
        awaiting: state.awaiting,
      },
      { onConflict: "telegram_identity_id" },
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

    const lastSeq =
      (
        data?.[0] as { order_number: string } | undefined
      )?.order_number?.replace(prefix, "") ?? "0000";
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
    orderSource: OrderSource;
  }): Promise<PersistedOrder> {
    const orderNumber = await this.generateOrderNumber(input.companyId);
    const { priced } = input;

    const { data: rpcData, error: rpcError } = await this.supabase.rpc(
      "create_draft_sales_order_atomic",
      {
        p_company_id: input.companyId,
        p_sales_id: input.salesId,
        p_order_number: orderNumber,
        p_customer_id: priced.customerId,
        p_customer_name_raw: priced.customerId ? null : priced.customerName,
        p_order_source: input.orderSource,
        p_knowledge_version: input.knowledgeVersion,
        p_extraction_confidence: input.extractionConfidence,
        p_missing_fields: input.missingFields,
        p_requires_discount_review: priced.requiresDiscountReview,
        p_delivery_note: priced.deliveryNote,
        p_telegram_event_id: input.telegramEventId,
        p_total_amount: priced.subtotal,
        p_discount_amount: priced.totalDiscount,
        p_final_amount: priced.estimatedTotal,
        p_items: priced.items.map((item) => ({
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
        })),
      },
    );

    if (rpcError)
      throw new Error(`createDraftOrder failed: ${rpcError.message}`);
    const row = ((rpcData ?? []) as { result_outcome: string; result_order_id: string }[])[0];
    if (!row || row.result_outcome !== "created") {
      const outcome = row?.result_outcome;
      if (isDraftOrderRejectionCode(outcome)) {
        throw new DraftOrderRejectedError(outcome, `createDraftOrder rejected: ${outcome}`);
      }
      throw new Error(`createDraftOrder failed: ${outcome ?? "empty RPC result"}`);
    }

    return {
      id: row.result_order_id,
      orderNumber,
      status: "draft",
      requiresDiscountReview: priced.requiresDiscountReview,
      priced,
      orderSource: input.orderSource,
    };
  }

  async updateDraftOrder(
    orderId: string,
    input: {
      companyId: string;
      actorId: string;
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
      orderSource: OrderSource;
    },
  ): Promise<PersistedOrder> {
    const { priced } = input;

    const { data: rpcData, error: rpcError } = await this.supabase.rpc(
      "update_draft_sales_order_atomic",
      {
        p_company_id: input.companyId,
        p_actor_id: input.actorId,
        p_order_id: orderId,
        p_customer_id: priced.customerId,
        p_customer_name_raw: priced.customerId ? null : priced.customerName,
        p_order_source: input.orderSource,
        p_knowledge_version: input.knowledgeVersion,
        p_extraction_confidence: input.extractionConfidence,
        p_missing_fields: input.missingFields,
        p_requires_discount_review: priced.requiresDiscountReview,
        p_delivery_note: priced.deliveryNote,
        p_total_amount: priced.subtotal,
        p_discount_amount: priced.totalDiscount,
        p_final_amount: priced.estimatedTotal,
        p_items: priced.items.map((item) => ({
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
        })),
      },
    );

    if (rpcError)
      throw new Error(`updateDraftOrder failed: ${rpcError.message}`);
    const row = ((rpcData ?? []) as { result_outcome: string }[])[0];
    if (!row || row.result_outcome !== "updated") {
      // "not_draft" adalah guard yang sudah ada sebelumnya (silent no-op) --
      // dipertahankan sebagai perilaku yang sama: kembalikan order apa adanya.
      if (row?.result_outcome === "not_draft") {
        const existing = await this.getOrder(orderId);
        if (existing) return existing;
      }
      const outcome = row?.result_outcome;
      if (isDraftOrderRejectionCode(outcome)) {
        throw new DraftOrderRejectedError(outcome, `updateDraftOrder rejected: ${outcome}`);
      }
      throw new Error(`updateDraftOrder failed: ${outcome ?? "empty RPC result"}`);
    }

    const updated = await this.getOrder(orderId);
    if (!updated)
      throw new Error("updateDraftOrder: order not found after update");
    return updated;
  }

  async getOrder(orderId: string): Promise<PersistedOrder | null> {
    const { data } = await this.supabase
      .from("sales_orders")
      .select(
        "id, order_number, status, requires_discount_review, customer_name_raw, delivery_note, total_amount, discount_amount, final_amount, order_source, customer:customers!customer_id(id, name), items:sales_order_items(product_id, product_name_raw, quantity, unit, unit_price, discount_type, discount_value, amount_before_discount, discount_exception, total_amount)",
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
      order_source: OrderSource;
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
        amountBeforeDiscount:
          i.amount_before_discount ?? i.quantity * i.unit_price,
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
      orderSource: row.order_source,
    };
  }

  async confirmOrder(
    orderId: string,
    companyId: string,
    actorId: string,
    options: { paymentTermsDays?: number | null } = {},
  ): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }> {
    const { data: rpcData, error: rpcError } = await this.supabase.rpc(
      "confirm_sales_order_atomic",
      {
        p_company_id: companyId,
        p_actor_id: actorId,
        p_order_id: orderId,
        p_payment_terms_days: options.paymentTermsDays ?? null,
      },
    );

    if (rpcError) throw new Error(`confirmOrder failed: ${rpcError.message}`);
    const row = ((rpcData ?? []) as { result_outcome: string; already_confirmed: boolean }[])[0];
    if (!row) throw new Error("confirmOrder failed: empty RPC result");
    if (row.result_outcome === "not_found") throw new Error("Order not found");
    if (row.result_outcome !== "confirmed" && row.result_outcome !== "already_confirmed") {
      throw new Error(`confirmOrder failed: ${row.result_outcome}`);
    }

    const updated = await this.getOrder(orderId);
    if (!updated) throw new Error("confirmOrder: order not found after update");
    return { order: updated, alreadyConfirmed: row.already_confirmed };
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

export interface InMemoryOrderAuditEvent {
  action: string;
  companyId: string;
  actorId: string;
  entityId: string;
  oldData: unknown;
  newData: unknown;
}

interface InMemoryMasterRow {
  companyId: string;
  isActive: boolean;
}

export class InMemorySalesOrderRepository implements SalesOrderTelegramRepository {
  private events = new Map<number, InMemoryEventRecord>();
  private identities = new Map<number, ResolvedIdentity>();
  private conversationStates = new Map<string, ConversationState>();
  private orders = new Map<string, PersistedOrder>();
  private auditTrail: InMemoryOrderAuditEvent[] = [];
  private customers = new Map<string, InMemoryMasterRow>();
  private products = new Map<string, InMemoryMasterRow>();
  // Default true: seluruh fixture test yang ada sebelum Gate 3E-D1-R1 selalu
  // merepresentasikan Salesman (satu-satunya role yang bisa ter-pairing saat
  // itu). Test baru yang butuh simulasi identity owner/admin ter-pairing
  // (tanpa capability sales.order.telegram) memanggil
  // seedSalesOrderCapability(..., false) secara eksplisit.
  private capabilityOverrides = new Map<string, boolean>();
  private seq = 0;

  seedIdentity(
    telegramChatId: number,
    identity: ResolvedIdentity,
    options: { isActive?: boolean } = {},
  ): void {
    // isActive=false meniru user/telegram_identities nonaktif di produksi:
    // resolveIdentity() mengembalikan null (bukan identity dengan flag) --
    // persis perilaku SQL asli (lihat SupabaseSalesOrderRepository.resolveIdentity),
    // supaya caller tidak bisa membedakan "belum pernah terdaftar" dari
    // "pernah terdaftar tapi sekarang nonaktif".
    if (options.isActive === false) return;
    this.identities.set(telegramChatId, identity);
  }

  /** Test-only (Gate 3E-D1-R1): override capability sales.order.telegram untuk satu user/tenant. */
  seedSalesOrderCapability(
    userId: string,
    companyId: string,
    allowed: boolean,
  ): void {
    this.capabilityOverrides.set(`${userId}:${companyId}`, allowed);
  }

  async hasSalesOrderCapability(
    userId: string,
    companyId: string,
  ): Promise<boolean> {
    return this.capabilityOverrides.get(`${userId}:${companyId}`) ?? true;
  }

  /** Test-only: registrasi toko (customers) untuk validasi createDraftOrder/updateDraftOrder. */
  seedCustomer(customerId: string, row: InMemoryMasterRow): void {
    this.customers.set(customerId, row);
  }

  /** Test-only: registrasi produk (products) untuk validasi createDraftOrder/updateDraftOrder. */
  seedProduct(productId: string, row: InMemoryMasterRow): void {
    this.products.set(productId, row);
  }

  /**
   * Mirror validasi create_draft_sales_order_atomic/update_draft_sales_order_atomic
   * (migration 20260908000001_gate_3e_b_order_intake_validation.sql) supaya
   * skenario DoD Gate 3E-B bisa diuji tanpa Supabase hidup. customerId/productId
   * NULL (tidak ter-match Knowledge Pack) sengaja TIDAK divalidasi -- fallback
   * raw-text tetap diterima & direview manusia (lihat pricing.ts/knowledge-provider.ts).
   */
  private validateDraftInput(companyId: string, priced: PricedOrder): void {
    if (priced.customerId !== null) {
      const c = this.customers.get(priced.customerId);
      if (!c || c.companyId !== companyId || !c.isActive) {
        throw new DraftOrderRejectedError("invalid_customer", "invalid customer");
      }
    }
    for (const item of priced.items) {
      if (item.productId !== null) {
        const p = this.products.get(item.productId);
        if (!p || p.companyId !== companyId || !p.isActive) {
          throw new DraftOrderRejectedError("invalid_product", "invalid product");
        }
      }
      if (!(item.quantity > 0)) {
        throw new DraftOrderRejectedError("invalid_quantity", "invalid quantity");
      }
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async findEventByUpdateId(
    telegramUpdateId: number,
  ): Promise<{ id: string } | null> {
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

  async updateEventStatus(
    eventId: string,
    processingStatus: EventProcessingStatus,
  ): Promise<void> {
    for (const [updateId, e] of this.events) {
      if (e.id === eventId)
        this.events.set(updateId, { ...e, status: processingStatus });
    }
  }

  /** Test-only helper: inspeksi baris event mentah (mis. verifikasi rawPayload tidak tersimpan). */
  getEventRecord(telegramUpdateId: number): InMemoryEventRecord | undefined {
    return this.events.get(telegramUpdateId);
  }

  async resolveIdentity(
    telegramChatId: number,
  ): Promise<ResolvedIdentity | null> {
    return this.identities.get(telegramChatId) ?? null;
  }

  async getConversationState(identityId: string): Promise<ConversationState> {
    return (
      this.conversationStates.get(identityId) ?? {
        pendingOrderId: null,
        awaiting: "none",
      }
    );
  }

  async setConversationState(
    identityId: string,
    _companyId: string,
    state: ConversationState,
  ): Promise<void> {
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
    orderSource: OrderSource;
  }): Promise<PersistedOrder> {
    this.validateDraftInput(input.companyId, input.priced);
    const id = this.nextId("order");
    const orderNumber = `SO-TEST-${this.seq}`;
    const order: PersistedOrder = {
      id,
      orderNumber,
      status: "draft",
      requiresDiscountReview: input.priced.requiresDiscountReview,
      priced: input.priced,
      orderSource: input.orderSource,
    };
    this.orders.set(id, order);
    this.auditTrail.push({
      action: "order.create",
      companyId: input.companyId,
      actorId: input.salesId,
      entityId: id,
      oldData: null,
      newData: { orderNumber, orderSource: input.orderSource },
    });
    return order;
  }

  async getOrder(orderId: string): Promise<PersistedOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async updateDraftOrder(
    orderId: string,
    input: {
      companyId: string;
      actorId: string;
      priced: PricedOrder;
      knowledgeVersion: string;
      extractionConfidence: number;
      missingFields: string[];
      orderSource: OrderSource;
    },
  ): Promise<PersistedOrder> {
    const existing = this.orders.get(orderId);
    if (!existing) throw new Error("Order not found");
    if (existing.status !== "draft") return existing; // guard, no-op
    this.validateDraftInput(input.companyId, input.priced);

    const updated: PersistedOrder = {
      ...existing,
      requiresDiscountReview: input.priced.requiresDiscountReview,
      priced: input.priced,
      orderSource: input.orderSource,
    };
    this.orders.set(orderId, updated);
    this.auditTrail.push({
      action: "order.update",
      companyId: input.companyId,
      actorId: input.actorId,
      entityId: orderId,
      oldData: { orderSource: existing.orderSource },
      newData: { orderSource: input.orderSource },
    });
    return updated;
  }

  async confirmOrder(
    orderId: string,
    companyId: string,
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- InMemory tidak memodelkan kolom DB payment_terms_days (lihat PersistedOrder), parameter dipertahankan hanya demi kesesuaian interface produksi.
    options: { paymentTermsDays?: number | null } = {},
  ): Promise<{ order: PersistedOrder; alreadyConfirmed: boolean }> {
    const existing = this.orders.get(orderId);
    if (!existing) throw new Error("Order not found");
    if (existing.status === "confirmed") {
      return { order: existing, alreadyConfirmed: true };
    }
    const updated: PersistedOrder = { ...existing, status: "confirmed" };
    this.orders.set(orderId, updated);
    this.auditTrail.push({
      action: "order.confirm",
      companyId,
      actorId,
      entityId: orderId,
      oldData: { status: existing.status },
      newData: { status: "confirmed" },
    });
    return { order: updated, alreadyConfirmed: false };
  }

  getAuditTrail(): InMemoryOrderAuditEvent[] {
    return this.auditTrail;
  }
}
