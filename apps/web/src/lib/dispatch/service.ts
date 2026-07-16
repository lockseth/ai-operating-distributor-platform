// =============================================================================
// AI Dispatch Planner — deterministic rule engine (pure functions, no I/O)
//
// AI Order → Delivery Planning MVP (AODP Waluyo). Mengevaluasi Area, Stock
// (System/Reserved/Expected Incoming), Customer Requested Date, Tonase, dan
// Planning Rules (tenant policy) untuk memutuskan apakah sebuah confirmed
// sales order dapat AUTO SCHEDULE atau perlu Human Override.
//
// Prioritas evaluasi (satu order = satu keputusan, bukan beberapa alasan
// bersamaan -- "jangan overload satu status"):
//   1. Customer Requested Delivery Date (instruksi eksplisit customer wajib
//      dihormati -- AI tidak boleh memaksa tanggal lain)
//   2. Available To Promise / Waiting Stock (barang benar-benar tidak cukup)
//   3. Tonase / Route Conflict (muatan grup melebihi kapasitas)
//   4. Bersih -> AUTO SCHEDULE
// =============================================================================

import type { PlanningDecision, PlanningInput, PlanningLineItem } from "./types";

export function computeGroupKey(area: string | null, date: string): string {
  return `${area ?? "unknown"}|${date}`;
}

export function computeAvailableToPromise(
  productId: string,
  input: Pick<PlanningInput, "systemStockByProduct" | "reservedByProduct" | "expectedIncomingByProduct">
): number {
  const system = input.systemStockByProduct[productId] ?? 0;
  const reserved = input.reservedByProduct[productId] ?? 0;
  const incoming = input.expectedIncomingByProduct[productId] ?? 0;
  return system - reserved + incoming;
}

function computeOrderTonnageKg(lineItems: PlanningLineItem[]): { totalKg: number; hasUnknownWeight: boolean } {
  let totalKg = 0;
  let hasUnknownWeight = false;
  for (const item of lineItems) {
    if (item.weightKgPerUnit === null) {
      hasUnknownWeight = true;
      continue; // produk tanpa data berat dikecualikan dari cek tonase, bukan dianggap 0
    }
    totalKg += item.weightKgPerUnit * item.quantity;
  }
  return { totalKg, hasUnknownWeight };
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

function baseConfidence(input: PlanningInput, hasUnknownWeight: boolean): number {
  let score = 1;
  if (input.customerArea === null) score -= 0.1;
  if (hasUnknownWeight && input.maxTonnagePerRouteKg !== null) score -= 0.25;
  if (input.orderMarginValue === null && input.minOrderValueForSameDay !== null) score -= 0.15;
  if (input.defaultActorStrategy === "order_salesperson" && !input.orderSalespersonId) score -= 0.15;
  return clampConfidence(score);
}

export function planDispatch(input: PlanningInput): PlanningDecision {
  const area = input.customerArea;
  const { totalKg, hasUnknownWeight } = computeOrderTonnageKg(input.lineItems);
  const confidence = baseConfidence(input, hasUnknownWeight);

  const assignedActorId =
    input.defaultActorStrategy === "order_salesperson" ? (input.orderSalespersonId ?? null) : null;

  // 1. Customer Requested Delivery Date -- instruksi eksplisit, AI tidak
  // boleh memaksa tanggal lain. Ini BUKAN uncertainty (confidence tetap
  // tinggi) -- hanya penjadwalan yang dibentuk oleh permintaan customer,
  // bukan pilihan bebas AI.
  if (input.requestedDeliveryDate && input.requestedDeliveryDate !== input.candidateDeliveryDate) {
    return {
      planningStatus: "customer_requested_delay",
      deliveryDate: input.requestedDeliveryDate,
      deliveryArea: area,
      deliveryGroupKey: computeGroupKey(area, input.requestedDeliveryDate),
      assignedActorId,
      planningReason: `Customer meminta tanggal kirim ${input.requestedDeliveryDate}; AI tidak memaksa jadwal ${input.candidateDeliveryDate}.`,
      confidenceScore: clampConfidence(Math.max(confidence, 0.9)),
    };
  }

  const deliveryDate = input.requestedDeliveryDate ?? input.candidateDeliveryDate;
  const groupKey = computeGroupKey(area, deliveryDate);

  // 2. Available To Promise -- System Stock - Reserved + Expected Incoming.
  const insufficientItems = input.lineItems.filter(
    (item) => computeAvailableToPromise(item.productId, input) < item.quantity
  );
  if (insufficientItems.length > 0) {
    return {
      planningStatus: "waiting_stock",
      deliveryDate,
      deliveryArea: area,
      deliveryGroupKey: groupKey,
      assignedActorId,
      planningReason: `${insufficientItems.length} item tidak cukup Available To Promise (System Stock - Reserved + Expected Incoming) untuk tanggal ${deliveryDate}.`,
      confidenceScore: 0.4,
    };
  }

  // 3. Tonase / Route Conflict -- hanya dicek bila tenant menetapkan batas.
  if (input.maxTonnagePerRouteKg !== null) {
    const existingGroupKg = input.existingGroupTonnageKg[groupKey] ?? 0;
    if (existingGroupKg + totalKg > input.maxTonnagePerRouteKg) {
      return {
        planningStatus: "route_conflict",
        deliveryDate,
        deliveryArea: area,
        deliveryGroupKey: groupKey,
        assignedActorId,
        planningReason: `Tonase grup ${groupKey} akan menjadi ${(existingGroupKg + totalKg).toFixed(1)}kg, melebihi batas ${input.maxTonnagePerRouteKg}kg.`,
        confidenceScore: 0.5,
      };
    }
  }

  // 4. Bersih -- AUTO SCHEDULE.
  return {
    planningStatus: "scheduled",
    deliveryDate,
    deliveryArea: area,
    deliveryGroupKey: groupKey,
    assignedActorId,
    planningReason: `Auto-scheduled: area ${area ?? "tidak diketahui"}, stok cukup, tonase dalam batas.`,
    confidenceScore: confidence,
  };
}
