// =============================================================================
// AI Dispatch Planner — domain types
//
// "AI" di sini adalah deterministic rule engine (business policy + data
// operasional), bukan panggilan LLM -- konsisten dengan pola yang sudah ada
// di lib/delivery/service.ts (computeInvoiceEligibility, requiresOwnerAlert).
// Confidence score merefleksikan kelengkapan data & kedekatan ke threshold,
// bukan probabilitas model statistik.
// =============================================================================

export type PlanningStatus =
  | "document_ready"
  | "waiting_planning"
  | "planned"
  | "scheduled"
  | "ready_for_delivery"
  | "waiting_stock"
  | "customer_requested_delay"
  | "manual_hold"
  | "route_conflict"
  | "cancelled";

export const CONFLICT_STATUSES: readonly PlanningStatus[] = [
  "waiting_stock",
  "customer_requested_delay",
  "manual_hold",
  "route_conflict",
];

export interface DispatchPlan {
  id: string;
  companyId: string;
  salesOrderId: string;
  planningStatus: PlanningStatus;
  deliveryDate: string | null; // ISO date (YYYY-MM-DD)
  deliveryArea: string | null;
  deliveryGroupKey: string | null;
  assignedActorId: string | null;
  planningReason: string;
  confidenceScore: number; // 0..1
  isOverride: boolean;
  plannedAt: string | null;
  scheduledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Planning input -- semua data operasional yang dievaluasi planDispatch().
// Dikumpulkan oleh repository dari sales_orders/sales_order_items/products/
// customers/dispatch_plans lain (untuk agregasi tonase per group), BUKAN
// dihitung di dalam service.ts (pure function, tidak boleh I/O).
// ---------------------------------------------------------------------------

export interface PlanningLineItem {
  productId: string;
  quantity: number;
  weightKgPerUnit: number | null; // null = berat tidak diketahui
}

export interface PlanningInput {
  companyId: string;
  salesOrderId: string;
  customerArea: string | null;
  requestedDeliveryDate: string | null; // preferensi customer, ISO date
  orderValue: number;
  orderMarginValue: number | null; // null bila cost produk tidak lengkap
  lineItems: PlanningLineItem[];
  systemStockByProduct: Record<string, number>; // products.stock_quantity
  reservedByProduct: Record<string, number>; // agregat qty dari dispatch_plans aktif lain
  expectedIncomingByProduct: Record<string, number>; // input eksternal, default {} (lihat Known Limitations)
  existingGroupTonnageKg: Record<string, number>; // tonase yang sudah terisi per delivery_group_key
  candidateDeliveryDate: string; // tanggal kandidat yang sedang dievaluasi (biasanya hari ini/besok)
  maxTonnagePerRouteKg: number | null; // tenant policy, null = tidak dicek
  minOrderValueForSameDay: number | null; // tenant policy, null = tidak dicek
  defaultActorStrategy: "order_salesperson" | "unassigned";
  orderSalespersonId: string | null;
}

export interface PlanningDecision {
  planningStatus: PlanningStatus;
  deliveryDate: string | null;
  deliveryArea: string | null;
  deliveryGroupKey: string | null;
  assignedActorId: string | null;
  planningReason: string;
  confidenceScore: number;
}

// ---------------------------------------------------------------------------
// Human override
// ---------------------------------------------------------------------------

export type OverrideAction =
  | "reschedule" // ganti tanggal kirim
  | "regroup" // ubah grouping/area
  | "reassign_actor" // ubah delivery actor
  | "hold" // tunda (manual_hold)
  | "force_dispatch"; // paksa kirim walau ada conflict

export interface OverrideInput {
  action: OverrideAction;
  reason: string; // wajib, non-empty
  deliveryDate?: string;
  deliveryArea?: string;
  assignedActorId?: string | null;
  actorId: string; // siapa yang melakukan override (audit)
}

export interface DispatchPlanEvent {
  id: string;
  companyId: string;
  dispatchPlanId: string;
  eventType: string;
  fromStatus: PlanningStatus | null;
  toStatus: PlanningStatus | null;
  actorId: string | null;
  isAiDecision: boolean;
  reason: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
