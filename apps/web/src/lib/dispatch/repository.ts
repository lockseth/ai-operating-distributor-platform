// =============================================================================
// Repository — abstraksi persistence untuk AI Dispatch Planner.
//
// getPlanningInput() mengumpulkan seluruh data operasional (area, stock,
// tonase, tenant policy) dari beberapa tabel yang SUDAH ADA (sales_orders,
// sales_order_items, products, customers, settings) + dispatch_plans lain
// yang masih aktif (untuk reserved stock & tonase grup) -- TIDAK ada RPC
// baru, murni query berlapis (aman untuk skala SME, MVP).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonValue, KnowledgeCandidateInput } from "@flowsales/types";
import { readTenantPolicy } from "@flowsales/shared";
import { insertKnowledgeCandidate as insertKnowledgeCandidateShared } from "@flowsales/database";
import type {
  DispatchPlan,
  DispatchPlanEvent,
  OverrideAction,
  PlanningDecision,
  PlanningInput,
  PlanningLineItem,
  PlanningStatus,
} from "./types";

const ACTIVE_PLANNING_STATUSES: readonly PlanningStatus[] = [
  "document_ready",
  "waiting_planning",
  "planned",
  "scheduled",
  "ready_for_delivery",
  "waiting_stock",
  "customer_requested_delay",
  "manual_hold",
  "route_conflict",
];

export interface CreatePlanInput {
  companyId: string;
  salesOrderId: string;
  createdBy: string | null;
}

export interface DispatchPlanEventInput {
  companyId: string;
  dispatchPlanId: string;
  eventType: string;
  fromStatus: PlanningStatus | null;
  toStatus: PlanningStatus | null;
  actorId: string | null;
  isAiDecision: boolean;
  reason: string | null;
  payload: Record<string, unknown>;
}

export interface TenantDispatchPolicy {
  maxTonnagePerRouteKg: number | null;
  minOrderValueForSameDay: number | null;
  defaultActorStrategy: "order_salesperson" | "unassigned";
}

const DEFAULT_POLICY: TenantDispatchPolicy = {
  maxTonnagePerRouteKg: null,
  minOrderValueForSameDay: null,
  defaultActorStrategy: "unassigned",
};

export interface SalesmanOption {
  id: string;
  fullName: string;
}

export interface DispatchRepositoryInterface {
  findPlanBySalesOrder(companyId: string, salesOrderId: string): Promise<DispatchPlan | null>;
  getPlan(companyId: string, planId: string): Promise<DispatchPlan | null>;
  createPlan(input: CreatePlanInput): Promise<DispatchPlan>;
  /** Daftar user dengan role 'sales', aktif, dalam company yang sama -- satu-satunya sumber "Salesman" yang sah untuk assignment. */
  findSalesmenByCompany(companyId: string): Promise<SalesmanOption[]>;
  /** Verifikasi ulang server-side: userId benar-benar Salesman aktif di company ini. */
  isSalesmanInCompany(companyId: string, userId: string): Promise<boolean>;
  /** Idempotency check untuk event non-status-changing seperti human_reviewed. */
  hasEventOfType(companyId: string, dispatchPlanId: string, eventType: string): Promise<boolean>;
  getPlanningInput(
    companyId: string,
    salesOrderId: string,
    candidateDeliveryDate: string,
    excludePlanId: string
  ): Promise<PlanningInput | null>;
  applyPlanningDecision(planId: string, decision: PlanningDecision, isOverride: boolean): Promise<DispatchPlan>;
  markReadyForDelivery(companyId: string, planId: string, actorId: string): Promise<DispatchPlan>;
  insertEvent(input: DispatchPlanEventInput): Promise<void>;
  insertKnowledgeCandidate(input: {
    companyId: string;
    dispatchPlanId: string;
    salesOrderId: string;
    action: OverrideAction;
    reason: string;
    submittedBy: string;
    previousDecision: PlanningDecision;
    newDecision: { deliveryDate?: string; deliveryArea?: string; assignedActorId?: string | null };
  }): Promise<void>;
}

function mapPlanRow(row: Record<string, unknown>): DispatchPlan {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    salesOrderId: row.sales_order_id as string,
    planningStatus: row.planning_status as PlanningStatus,
    deliveryDate: (row.delivery_date as string | null) ?? null,
    deliveryArea: (row.delivery_area as string | null) ?? null,
    deliveryGroupKey: (row.delivery_group_key as string | null) ?? null,
    assignedActorId: (row.assigned_actor_id as string | null) ?? null,
    planningReason: (row.planning_reason as string) ?? "",
    confidenceScore: Number(row.confidence_score ?? 0),
    isOverride: Boolean(row.is_override),
    plannedAt: (row.planned_at as string | null) ?? null,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SupabaseDispatchRepository implements DispatchRepositoryInterface {
  constructor(private readonly supabase: SupabaseClient) {}

  async findPlanBySalesOrder(companyId: string, salesOrderId: string): Promise<DispatchPlan | null> {
    const { data } = await this.supabase
      .from("dispatch_plans")
      .select("*")
      .eq("company_id", companyId)
      .eq("sales_order_id", salesOrderId)
      .maybeSingle();
    return data ? mapPlanRow(data) : null;
  }

  async getPlan(companyId: string, planId: string): Promise<DispatchPlan | null> {
    const { data } = await this.supabase
      .from("dispatch_plans")
      .select("*")
      .eq("company_id", companyId)
      .eq("id", planId)
      .maybeSingle();
    return data ? mapPlanRow(data) : null;
  }

  async createPlan(input: CreatePlanInput): Promise<DispatchPlan> {
    const existing = await this.findPlanBySalesOrder(input.companyId, input.salesOrderId);
    if (existing) return existing; // idempotent — UNIQUE(company_id, sales_order_id) di DB sebagai jaminan atomic

    const { data, error } = await this.supabase
      .from("dispatch_plans")
      .insert({
        company_id: input.companyId,
        sales_order_id: input.salesOrderId,
        planning_status: "document_ready",
        planning_reason: "Order confirmed — menunggu evaluasi AI Dispatch Planner.",
        created_by: input.createdBy,
      })
      .select("*")
      .single();

    if (error) {
      // Race: dua request bersamaan — UNIQUE constraint akan menolak salah
      // satu; ambil baris yang sudah ada sebagai hasil idempotent.
      const race = await this.findPlanBySalesOrder(input.companyId, input.salesOrderId);
      if (race) return race;
      throw new Error(`Gagal membuat dispatch plan: ${error.message}`);
    }
    return mapPlanRow(data);
  }

  async findSalesmenByCompany(companyId: string): Promise<SalesmanOption[]> {
    // Pola sama seperti daftar driver di orders/[id]/page.tsx: user_roles
    // join users+roles, filter role='sales' & aktif di sisi aplikasi (bukan
    // filter PostgREST bersarang) -- konsisten dengan pola yang sudah
    // terbukti bekerja di repo ini.
    const { data } = await this.supabase
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", companyId);

    const rows = (data ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean } | null;
      role: { name: string } | null;
    }[];

    return rows
      .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
      .map((r) => ({ id: r.user!.id, fullName: r.user!.full_name }));
  }

  async isSalesmanInCompany(companyId: string, userId: string): Promise<boolean> {
    const salesmen = await this.findSalesmenByCompany(companyId);
    return salesmen.some((s) => s.id === userId);
  }

  async hasEventOfType(companyId: string, dispatchPlanId: string, eventType: string): Promise<boolean> {
    const { data } = await this.supabase
      .from("dispatch_plan_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("dispatch_plan_id", dispatchPlanId)
      .eq("event_type", eventType)
      .limit(1);
    return (data ?? []).length > 0;
  }

  private async getTenantPolicy(companyId: string): Promise<TenantDispatchPolicy> {
    const keys = [
      "dispatch_planning.max_tonnage_per_route_kg",
      "dispatch_planning.min_order_value_for_same_day",
      "dispatch_planning.default_actor_strategy",
    ];
    const { data } = await this.supabase.from("settings").select("key, value").eq("company_id", companyId).in("key", keys);

    // I/O (query keys mana yang relevan) tetap tanggung jawab domain ini —
    // hanya lookup+fallback per-key yang distandardisasi lewat readTenantPolicy.
    const settingsMap: Record<string, JsonValue> = {};
    for (const row of data ?? []) {
      settingsMap[row.key] = row.value as JsonValue;
    }

    const maxTonnageRaw = readTenantPolicy(settingsMap, "dispatch_planning.max_tonnage_per_route_kg", null as number | null);
    const minOrderValueRaw = readTenantPolicy(settingsMap, "dispatch_planning.min_order_value_for_same_day", null as number | null);
    const actorStrategyRaw = readTenantPolicy(
      settingsMap,
      "dispatch_planning.default_actor_strategy",
      DEFAULT_POLICY.defaultActorStrategy as JsonValue
    );

    return {
      maxTonnagePerRouteKg: typeof maxTonnageRaw === "number" ? maxTonnageRaw : Number(maxTonnageRaw) || null,
      minOrderValueForSameDay: typeof minOrderValueRaw === "number" ? minOrderValueRaw : Number(minOrderValueRaw) || null,
      defaultActorStrategy: actorStrategyRaw === "order_salesperson" ? "order_salesperson" : "unassigned",
    };
  }

  async getPlanningInput(
    companyId: string,
    salesOrderId: string,
    candidateDeliveryDate: string,
    excludePlanId: string
  ): Promise<PlanningInput | null> {
    const { data: order } = await this.supabase
      .from("sales_orders")
      .select("id, company_id, customer_id, sales_id, final_amount, requested_delivery_date, customers(area)")
      .eq("id", salesOrderId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (!order) return null;

    const { data: items } = await this.supabase
      .from("sales_order_items")
      .select("product_id, quantity, total_amount, products(weight_kg, stock_quantity, cost, price)")
      .eq("order_id", salesOrderId);

    const lineItems: PlanningLineItem[] = (items ?? []).map((row: Record<string, unknown>) => {
      const product = row.products as Record<string, unknown> | null;
      return {
        productId: row.product_id as string,
        quantity: Number(row.quantity),
        weightKgPerUnit: product?.weight_kg != null ? Number(product.weight_kg) : null,
      };
    });

    const systemStockByProduct: Record<string, number> = {};
    let hasCostGap = false;
    let orderMarginValue = 0;
    for (const row of (items ?? []) as Record<string, unknown>[]) {
      const product = row.products as Record<string, unknown> | null;
      const productId = row.product_id as string;
      systemStockByProduct[productId] = Number(product?.stock_quantity ?? 0);
      if (product?.cost == null) {
        hasCostGap = true;
      } else {
        orderMarginValue += (Number(product.price ?? 0) - Number(product.cost)) * Number(row.quantity);
      }
    }

    const policy = await this.getTenantPolicy(companyId);

    // Reserved + tonase grup lain: agregat dari dispatch_plans aktif LAIN
    // (exclude plan order ini sendiri) milik company yang sama.
    const { data: otherPlans } = await this.supabase
      .from("dispatch_plans")
      .select("id, sales_order_id, delivery_group_key")
      .eq("company_id", companyId)
      .in("planning_status", ACTIVE_PLANNING_STATUSES as string[])
      .neq("id", excludePlanId);

    const reservedByProduct: Record<string, number> = {};
    const existingGroupTonnageKg: Record<string, number> = {};

    const otherOrderIds = (otherPlans ?? []).map((p) => p.sales_order_id as string);
    if (otherOrderIds.length > 0) {
      const { data: otherItems } = await this.supabase
        .from("sales_order_items")
        .select("order_id, product_id, quantity, products(weight_kg)")
        .in("order_id", otherOrderIds);

      const groupKeyByOrderId = new Map<string, string | null>();
      for (const p of otherPlans ?? []) {
        groupKeyByOrderId.set(p.sales_order_id as string, (p.delivery_group_key as string | null) ?? null);
      }

      for (const row of (otherItems ?? []) as Record<string, unknown>[]) {
        const productId = row.product_id as string;
        const qty = Number(row.quantity);
        reservedByProduct[productId] = (reservedByProduct[productId] ?? 0) + qty;

        const groupKey = groupKeyByOrderId.get(row.order_id as string);
        const product = row.products as Record<string, unknown> | null;
        if (groupKey && product?.weight_kg != null) {
          existingGroupTonnageKg[groupKey] = (existingGroupTonnageKg[groupKey] ?? 0) + Number(product.weight_kg) * qty;
        }
      }
    }

    const customer = order.customers as unknown as { area: string | null } | null;

    return {
      companyId,
      salesOrderId,
      customerArea: customer?.area ?? null,
      requestedDeliveryDate: (order.requested_delivery_date as string | null) ?? null,
      orderValue: Number(order.final_amount ?? 0),
      orderMarginValue: hasCostGap ? null : orderMarginValue,
      lineItems,
      systemStockByProduct,
      reservedByProduct,
      expectedIncomingByProduct: {}, // belum ada sumber data — lihat Known Limitations
      existingGroupTonnageKg,
      candidateDeliveryDate,
      maxTonnagePerRouteKg: policy.maxTonnagePerRouteKg,
      minOrderValueForSameDay: policy.minOrderValueForSameDay,
      defaultActorStrategy: policy.defaultActorStrategy,
      orderSalespersonId: (order.sales_id as string | null) ?? null,
    };
  }

  async applyPlanningDecision(planId: string, decision: PlanningDecision, isOverride: boolean): Promise<DispatchPlan> {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      planning_status: decision.planningStatus,
      delivery_date: decision.deliveryDate,
      delivery_area: decision.deliveryArea,
      delivery_group_key: decision.deliveryGroupKey,
      assigned_actor_id: decision.assignedActorId,
      planning_reason: decision.planningReason,
      confidence_score: decision.confidenceScore,
      is_override: isOverride,
    };
    if (decision.planningStatus === "planned" || decision.planningStatus === "scheduled") {
      update.planned_at = now;
    }
    if (decision.planningStatus === "scheduled") {
      update.scheduled_at = now;
    }

    const { data, error } = await this.supabase.from("dispatch_plans").update(update).eq("id", planId).select("*").single();
    if (error) throw new Error(`Gagal update dispatch plan: ${error.message}`);
    return mapPlanRow(data);
  }

  async markReadyForDelivery(companyId: string, planId: string, _actorId: string): Promise<DispatchPlan> {
    const { data, error } = await this.supabase
      .from("dispatch_plans")
      .update({ planning_status: "ready_for_delivery" })
      .eq("id", planId)
      .eq("company_id", companyId)
      .eq("planning_status", "scheduled") // hanya dari scheduled — mencegah lompat state
      .select("*")
      .single();
    if (error) throw new Error(`Gagal mark ready_for_delivery: ${error.message}`);
    return mapPlanRow(data);
  }

  async insertEvent(input: DispatchPlanEventInput): Promise<void> {
    const { error } = await this.supabase.from("dispatch_plan_events").insert({
      company_id: input.companyId,
      dispatch_plan_id: input.dispatchPlanId,
      event_type: input.eventType,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      actor_id: input.actorId,
      is_ai_decision: input.isAiDecision,
      reason: input.reason,
      payload: input.payload,
    });
    if (error) throw new Error(`Gagal insert dispatch_plan_events: ${error.message}`);
  }

  async insertKnowledgeCandidate(input: {
    companyId: string;
    dispatchPlanId: string;
    salesOrderId: string;
    action: OverrideAction;
    reason: string;
    submittedBy: string;
    previousDecision: PlanningDecision;
    newDecision: { deliveryDate?: string; deliveryArea?: string; assignedActorId?: string | null };
  }): Promise<void> {
    const candidate: KnowledgeCandidateInput = {
      companyId: input.companyId,
      candidateType: "dispatch_planning_override",
      rawText: `AI: ${input.previousDecision.planningReason}`,
      suggestedValue: {
        dispatchPlanId: input.dispatchPlanId,
        action: input.action,
        reason: input.reason,
        previousDecision: input.previousDecision as unknown as JsonValue,
        newDecision: input.newDecision as unknown as JsonValue,
      },
      sourceOrderId: input.salesOrderId, // fix: sebelumnya tidak diisi (lihat Operating Brain Readiness Report §C3)
      submittedBy: input.submittedBy,
    };
    await insertKnowledgeCandidateShared(this.supabase, candidate);
  }
}

// =============================================================================
// InMemoryDispatchRepository — untuk test (vitest), tidak menyentuh Postgres.
// =============================================================================

export class InMemoryDispatchRepository implements DispatchRepositoryInterface {
  public plans = new Map<string, DispatchPlan>();
  public events: DispatchPlanEvent[] = [];
  public knowledgeCandidates: Array<{
    companyId: string;
    candidateType: string;
    sourceOrderId: string | null;
    suggestedValue: Record<string, unknown>;
  }> = [];
  private planningInputs = new Map<string, PlanningInput>();
  private idCounter = 0;
  /** company -> daftar salesman aktif yang sah untuk company itu. */
  private salesmenByCompany = new Map<string, SalesmanOption[]>();

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  seedPlanningInput(salesOrderId: string, input: PlanningInput): void {
    this.planningInputs.set(salesOrderId, input);
  }

  seedSalesmen(companyId: string, salesmen: SalesmanOption[]): void {
    this.salesmenByCompany.set(companyId, salesmen);
  }

  async findSalesmenByCompany(companyId: string): Promise<SalesmanOption[]> {
    return this.salesmenByCompany.get(companyId) ?? [];
  }

  async isSalesmanInCompany(companyId: string, userId: string): Promise<boolean> {
    return (this.salesmenByCompany.get(companyId) ?? []).some((s) => s.id === userId);
  }

  async hasEventOfType(companyId: string, dispatchPlanId: string, eventType: string): Promise<boolean> {
    return this.events.some(
      (e) => e.companyId === companyId && e.dispatchPlanId === dispatchPlanId && e.eventType === eventType
    );
  }

  async findPlanBySalesOrder(companyId: string, salesOrderId: string): Promise<DispatchPlan | null> {
    for (const plan of this.plans.values()) {
      if (plan.companyId === companyId && plan.salesOrderId === salesOrderId) return plan;
    }
    return null;
  }

  async getPlan(companyId: string, planId: string): Promise<DispatchPlan | null> {
    const plan = this.plans.get(planId);
    if (!plan || plan.companyId !== companyId) return null;
    return plan;
  }

  async createPlan(input: CreatePlanInput): Promise<DispatchPlan> {
    const existing = await this.findPlanBySalesOrder(input.companyId, input.salesOrderId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const plan: DispatchPlan = {
      id: this.nextId("plan"),
      companyId: input.companyId,
      salesOrderId: input.salesOrderId,
      planningStatus: "document_ready",
      deliveryDate: null,
      deliveryArea: null,
      deliveryGroupKey: null,
      assignedActorId: null,
      planningReason: "Order confirmed — menunggu evaluasi AI Dispatch Planner.",
      confidenceScore: 0,
      isOverride: false,
      plannedAt: null,
      scheduledAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  async getPlanningInput(
    _companyId: string,
    salesOrderId: string,
    candidateDeliveryDate: string,
    _excludePlanId: string
  ): Promise<PlanningInput | null> {
    const seeded = this.planningInputs.get(salesOrderId);
    if (!seeded) return null;

    // reserved & tonase grup dihitung dari plan lain yang aktif (meniru
    // logika SupabaseDispatchRepository) supaya test concurrency/reservation
    // benar-benar merefleksikan efek plan sebelumnya, bukan nilai seed statis.
    const reservedByProduct: Record<string, number> = { ...seeded.reservedByProduct };
    const existingGroupTonnageKg: Record<string, number> = { ...seeded.existingGroupTonnageKg };

    return { ...seeded, candidateDeliveryDate, reservedByProduct, existingGroupTonnageKg };
  }

  async applyPlanningDecision(planId: string, decision: PlanningDecision, isOverride: boolean): Promise<DispatchPlan> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error("Plan not found");
    const now = new Date().toISOString();
    const updated: DispatchPlan = {
      ...plan,
      planningStatus: decision.planningStatus,
      deliveryDate: decision.deliveryDate,
      deliveryArea: decision.deliveryArea,
      deliveryGroupKey: decision.deliveryGroupKey,
      assignedActorId: decision.assignedActorId,
      planningReason: decision.planningReason,
      confidenceScore: decision.confidenceScore,
      isOverride,
      plannedAt: decision.planningStatus === "planned" || decision.planningStatus === "scheduled" ? now : plan.plannedAt,
      scheduledAt: decision.planningStatus === "scheduled" ? now : plan.scheduledAt,
      updatedAt: now,
    };
    this.plans.set(planId, updated);
    return updated;
  }

  async markReadyForDelivery(companyId: string, planId: string, _actorId: string): Promise<DispatchPlan> {
    const plan = this.plans.get(planId);
    if (!plan || plan.companyId !== companyId) throw new Error("Plan not found");
    if (plan.planningStatus !== "scheduled") throw new Error("Plan not in scheduled status");
    const updated: DispatchPlan = { ...plan, planningStatus: "ready_for_delivery", updatedAt: new Date().toISOString() };
    this.plans.set(planId, updated);
    return updated;
  }

  async insertEvent(input: DispatchPlanEventInput): Promise<void> {
    this.events.push({
      id: this.nextId("event"),
      companyId: input.companyId,
      dispatchPlanId: input.dispatchPlanId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actorId: input.actorId,
      isAiDecision: input.isAiDecision,
      reason: input.reason,
      payload: input.payload,
      createdAt: new Date().toISOString(),
    });
  }

  async insertKnowledgeCandidate(input: {
    companyId: string;
    dispatchPlanId: string;
    salesOrderId: string;
    action: OverrideAction;
    reason: string;
    submittedBy: string;
    previousDecision: PlanningDecision;
    newDecision: { deliveryDate?: string; deliveryArea?: string; assignedActorId?: string | null };
  }): Promise<void> {
    this.knowledgeCandidates.push({
      companyId: input.companyId,
      candidateType: "dispatch_planning_override",
      sourceOrderId: input.salesOrderId,
      suggestedValue: {
        dispatchPlanId: input.dispatchPlanId,
        action: input.action,
        reason: input.reason,
        previousDecision: input.previousDecision,
        newDecision: input.newDecision,
      },
    });
  }
}
