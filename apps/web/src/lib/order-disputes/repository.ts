import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyRequest, mapResolutionToStatus, resolutionCancelsOrder } from "./service";
import type {
  CreateDisputeRequestInput,
  CreateDisputeRequestResult,
  ResolveDisputeRequestInput,
  ResolveDisputeRequestResult,
  DisputeRequestRecord,
  OrderStage,
  RequestStatus,
  AiClassification,
} from "./types";

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  customerId: string | null;
  customerName: string;
  finalAmount: number;
}

export interface OrderDisputeRepository {
  createRequest(input: CreateDisputeRequestInput): Promise<CreateDisputeRequestResult>;
  resolveRequest(input: ResolveDisputeRequestInput): Promise<ResolveDisputeRequestResult>;
  getRequest(companyId: string, requestId: string): Promise<DisputeRequestRecord | null>;
  findOrderByNumber(companyId: string, orderNumber: string): Promise<OrderSummary | null>;
  /** Jumlah request dispute/cancel dari customer yang sama dalam N hari terakhir (untuk deteksi pola berulang). */
  countRecentDisputesForCustomer(companyId: string, customerId: string, sinceIso: string): Promise<number>;
  getHighValueThreshold(companyId: string): Promise<number | null>;
  createOwnerAlert(input: {
    companyId: string;
    salesOrderId: string;
    alertType: string;
    severity: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }): Promise<void>;
}

// -----------------------------------------------------------------------
// Supabase
// -----------------------------------------------------------------------

export class SupabaseOrderDisputeRepository implements OrderDisputeRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async createRequest(input: CreateDisputeRequestInput): Promise<CreateDisputeRequestResult> {
    const { data, error } = await this.supabase.rpc("create_order_cancellation_dispute", {
      p_company_id: input.companyId,
      p_sales_order_id: input.salesOrderId,
      p_request_type: input.requestType,
      p_reason_code: input.reasonCode,
      p_notes: input.notes,
      p_reported_pic_name: input.reportedPicName,
      p_reported_pic_phone: input.reportedPicPhone,
      p_contact_source: input.contactSource,
      p_requested_by: input.requestedBy,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as
      | { result_outcome: string; request_id: string | null; order_stage: OrderStage | null; ai_classification: string | null; auto_cancelled: boolean }
      | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    if (row.result_outcome === "created" || row.result_outcome === "already_exists") {
      return {
        outcome: row.result_outcome,
        requestId: row.request_id!,
        orderStage: row.order_stage!,
        aiClassification: row.ai_classification as AiClassification,
        autoCancelled: row.auto_cancelled,
      };
    }
    if (
      row.result_outcome === "invalid_input" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "order_not_found" ||
      row.result_outcome === "order_already_cancelled" ||
      row.result_outcome === "already_has_active_request"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async resolveRequest(input: ResolveDisputeRequestInput): Promise<ResolveDisputeRequestResult> {
    const { data, error } = await this.supabase.rpc("resolve_order_cancellation_dispute", {
      p_company_id: input.companyId,
      p_request_id: input.requestId,
      p_reviewer_id: input.reviewerId,
      p_resolution: input.resolution,
      p_resolution_notes: input.resolutionNotes,
      p_actual_pic_name: input.actualPicName,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = (data ?? [])[0] as { result_outcome: string; new_status: string | null } | undefined;
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "resolved":
        return { outcome: "resolved", newStatus: row.new_status as RequestStatus };
      case "invalid_input":
        return { outcome: "invalid_input" };
      case "forbidden":
        return { outcome: "forbidden" };
      case "not_found":
        return { outcome: "not_found" };
      case "self_review_forbidden":
        return { outcome: "self_review_forbidden" };
      case "already_resolved":
        return { outcome: "already_resolved", currentStatus: row.new_status as RequestStatus };
      default:
        return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
    }
  }

  async getRequest(companyId: string, requestId: string): Promise<DisputeRequestRecord | null> {
    const { data } = await this.supabase
      .from("order_cancellation_disputes")
      .select("*")
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle();
    if (!data) return null;
    return mapRow(data as SupabaseDisputeRow);
  }

  async findOrderByNumber(companyId: string, orderNumber: string): Promise<OrderSummary | null> {
    const { data } = await this.supabase
      .from("sales_orders")
      .select("id, order_number, status, final_amount, customer_id, customer_name_raw, customer:customers!customer_id(id, name)")
      .eq("company_id", companyId)
      .eq("order_number", orderNumber)
      .maybeSingle();
    if (!data) return null;
    const row = data as unknown as {
      id: string;
      order_number: string;
      status: string;
      final_amount: number;
      customer_id: string | null;
      customer_name_raw: string | null;
      customer: { id: string; name: string } | null;
    };
    return {
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      customerId: row.customer?.id ?? row.customer_id,
      customerName: row.customer?.name ?? row.customer_name_raw ?? "(toko belum diketahui)",
      finalAmount: row.final_amount,
    };
  }

  async countRecentDisputesForCustomer(companyId: string, customerId: string, sinceIso: string): Promise<number> {
    const { count } = await this.supabase
      .from("order_cancellation_disputes")
      .select("id, sales_order:sales_orders!sales_order_id(customer_id)", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("sales_order.customer_id", customerId)
      .gte("requested_at", sinceIso);
    return count ?? 0;
  }

  async getHighValueThreshold(companyId: string): Promise<number | null> {
    const { data } = await this.supabase.from("companies").select("settings").eq("id", companyId).maybeSingle();
    const settings = (data as { settings?: Record<string, unknown> } | null)?.settings;
    const raw = settings?.high_value_order_threshold;
    return typeof raw === "number" ? raw : null;
  }

  async createOwnerAlert(input: {
    companyId: string;
    salesOrderId: string;
    alertType: string;
    severity: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.supabase.from("owner_alerts").insert({
      company_id: input.companyId,
      sales_order_id: input.salesOrderId,
      alert_type: input.alertType,
      channel: "whatsapp",
      severity: input.severity,
      payload: input.payload,
      status: "pending",
    });
  }
}

interface SupabaseDisputeRow {
  id: string;
  company_id: string;
  sales_order_id: string;
  request_type: string;
  reason_code: string;
  notes: string | null;
  reported_pic_name_snapshot: string | null;
  reported_pic_phone_snapshot: string | null;
  contact_source: string;
  order_stage_at_request: string;
  ai_classification: string | null;
  status: string;
  resolution: string | null;
  resolution_notes: string | null;
  actual_pic_name_snapshot: string | null;
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

function mapRow(row: SupabaseDisputeRow): DisputeRequestRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    salesOrderId: row.sales_order_id,
    requestType: row.request_type as DisputeRequestRecord["requestType"],
    reasonCode: row.reason_code,
    notes: row.notes,
    reportedPicName: row.reported_pic_name_snapshot,
    reportedPicPhone: row.reported_pic_phone_snapshot,
    contactSource: row.contact_source as DisputeRequestRecord["contactSource"],
    orderStageAtRequest: row.order_stage_at_request as OrderStage,
    aiClassification: row.ai_classification as DisputeRequestRecord["aiClassification"],
    status: row.status as RequestStatus,
    resolution: row.resolution as DisputeRequestRecord["resolution"],
    resolutionNotes: row.resolution_notes,
    actualPicName: row.actual_pic_name_snapshot,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  };
}

// -----------------------------------------------------------------------
// InMemory — untuk test. Meniru logika RPC (classifyRequest) supaya
// perilaku sama dengan produksi.
// -----------------------------------------------------------------------

interface InMemoryOrderSeed extends OrderSummary {
  companyId: string;
}

export class InMemoryOrderDisputeRepository implements OrderDisputeRepository {
  private orders = new Map<string, InMemoryOrderSeed>(); // key: orderId
  private orderStages = new Map<string, OrderStage>(); // key: orderId
  private activeUsers = new Set<string>(); // userId -- semua actor yang "ada" (is_active)
  private requests = new Map<string, DisputeRequestRecord>();
  private idempotencyIndex = new Map<string, string>(); // `${companyId}:${key}` -> requestId
  private nextId = 1;
  highValueThreshold: number | null = null;
  ownerAlerts: { companyId: string; salesOrderId: string; alertType: string; severity: string; payload: Record<string, unknown> }[] = [];

  seedOrder(order: InMemoryOrderSeed, stage: OrderStage): void {
    this.orders.set(order.id, order);
    this.orderStages.set(order.id, stage);
  }

  seedActiveUser(userId: string): void {
    this.activeUsers.add(userId);
  }

  setOrderStatus(orderId: string, status: string): void {
    const order = this.orders.get(orderId);
    if (order) this.orders.set(orderId, { ...order, status });
  }

  async createRequest(input: CreateDisputeRequestInput): Promise<CreateDisputeRequestResult> {
    if (!input.requestType || !input.reasonCode || !input.contactSource) {
      return { outcome: "invalid_input" };
    }

    if (input.idempotencyKey) {
      const key = `${input.companyId}:${input.idempotencyKey}`;
      const existingId = this.idempotencyIndex.get(key);
      if (existingId) {
        const existing = this.requests.get(existingId)!;
        return {
          outcome: "already_exists",
          requestId: existing.id,
          orderStage: existing.orderStageAtRequest,
          aiClassification: existing.aiClassification!,
          autoCancelled: existing.status === "APPROVED",
        };
      }
    }

    if (!this.activeUsers.has(input.requestedBy)) return { outcome: "forbidden" };

    const order = this.orders.get(input.salesOrderId);
    if (!order || order.companyId !== input.companyId) return { outcome: "order_not_found" };
    if (order.status === "cancelled") return { outcome: "order_already_cancelled" };

    const hasActive = [...this.requests.values()].some(
      (r) => r.salesOrderId === input.salesOrderId && (r.status === "REQUESTED" || r.status === "ON_HOLD")
    );
    if (hasActive) return { outcome: "already_has_active_request" };

    const stage = this.orderStages.get(input.salesOrderId) ?? "NOT_DISPATCHED";
    const { aiClassification, initialStatus, autoCancel } = classifyRequest(input.requestType, stage);

    const id = `dispute-${this.nextId++}`;
    const record: DisputeRequestRecord = {
      id,
      companyId: input.companyId,
      salesOrderId: input.salesOrderId,
      requestType: input.requestType,
      reasonCode: input.reasonCode,
      notes: input.notes,
      reportedPicName: input.reportedPicName,
      reportedPicPhone: input.reportedPicPhone,
      contactSource: input.contactSource,
      orderStageAtRequest: stage,
      aiClassification,
      status: initialStatus,
      resolution: autoCancel ? "CANCEL_APPROVED" : null,
      resolutionNotes: null,
      actualPicName: null,
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
    };
    this.requests.set(id, record);
    if (input.idempotencyKey) this.idempotencyIndex.set(`${input.companyId}:${input.idempotencyKey}`, id);

    if (autoCancel) this.setOrderStatus(input.salesOrderId, "cancelled");

    return { outcome: "created", requestId: id, orderStage: stage, aiClassification, autoCancelled: autoCancel };
  }

  async resolveRequest(input: ResolveDisputeRequestInput): Promise<ResolveDisputeRequestResult> {
    const request = this.requests.get(input.requestId);
    if (!request || request.companyId !== input.companyId) return { outcome: "not_found" };
    if (!this.activeUsers.has(input.reviewerId)) return { outcome: "forbidden" };
    if (request.requestedBy === input.reviewerId) return { outcome: "self_review_forbidden" };
    if (request.status !== "REQUESTED" && request.status !== "ON_HOLD") {
      return { outcome: "already_resolved", currentStatus: request.status };
    }

    const newStatus = mapResolutionToStatus(input.resolution);
    const updated: DisputeRequestRecord = {
      ...request,
      status: newStatus,
      resolution: input.resolution,
      resolutionNotes: input.resolutionNotes,
      actualPicName: input.actualPicName,
      reviewedBy: input.reviewerId,
      reviewedAt: new Date().toISOString(),
    };
    this.requests.set(request.id, updated);

    if (resolutionCancelsOrder(input.resolution)) {
      this.setOrderStatus(request.salesOrderId, "cancelled");
    }

    return { outcome: "resolved", newStatus };
  }

  async getRequest(companyId: string, requestId: string): Promise<DisputeRequestRecord | null> {
    const r = this.requests.get(requestId);
    if (!r || r.companyId !== companyId) return null;
    return r;
  }

  async findOrderByNumber(companyId: string, orderNumber: string): Promise<OrderSummary | null> {
    for (const order of this.orders.values()) {
      if (order.companyId === companyId && order.orderNumber === orderNumber) return order;
    }
    return null;
  }

  async countRecentDisputesForCustomer(companyId: string, customerId: string, sinceIso: string): Promise<number> {
    let count = 0;
    for (const r of this.requests.values()) {
      if (r.companyId !== companyId) continue;
      if (r.requestedAt < sinceIso) continue;
      const order = this.orders.get(r.salesOrderId);
      if (order?.customerId === customerId) count++;
    }
    return count;
  }

  async getHighValueThreshold(): Promise<number | null> {
    return this.highValueThreshold;
  }

  async createOwnerAlert(input: {
    companyId: string;
    salesOrderId: string;
    alertType: string;
    severity: "low" | "medium" | "high";
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.ownerAlerts.push(input);
  }

  // -- test helpers --
  getOrderStatus(orderId: string): string | undefined {
    return this.orders.get(orderId)?.status;
  }
  getRequestSync(requestId: string): DisputeRequestRecord | undefined {
    return this.requests.get(requestId);
  }
  totalRequestsForOrder(orderId: string): number {
    return [...this.requests.values()].filter((r) => r.salesOrderId === orderId).length;
  }
}
