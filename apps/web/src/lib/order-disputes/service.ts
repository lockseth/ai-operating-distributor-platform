// =============================================================================
// Order Cancellation & Dispute — aturan murni (tanpa I/O).
//
// classifyRequest() MENCERMINKAN logika di RPC
// create_order_cancellation_dispute (migration 20260725000001) — dua
// implementasi sengaja identik supaya InMemory repository (test) dan RPC
// Postgres (produksi) berperilaku sama. AI di sini = rule engine
// deterministik, BUKAN panggilan LLM (konsisten dengan dispatch/service.ts).
// =============================================================================

import type { AiClassification, ContactSource, OrderStage, RequestStatus, RequestType, Resolution } from "./types";

export interface ClassifyRequestResult {
  aiClassification: AiClassification;
  initialStatus: RequestStatus;
  autoCancel: boolean;
}

/**
 * AI hanya menentukan kategori tindak lanjut (AUTO_CANCEL_SAFE / NEEDS_REVIEW
 * / HOLD_AND_ALERT) — TIDAK PERNAH menghukum atau menonaktifkan Salesman.
 */
export function classifyRequest(requestType: RequestType, orderStage: OrderStage): ClassifyRequestResult {
  if (requestType === "CUSTOMER_DENIES_ORDER") {
    // Wajib Human Review selalu -- tidak pernah auto, di stage manapun.
    return { aiClassification: "HOLD_AND_ALERT", initialStatus: "ON_HOLD", autoCancel: false };
  }

  if (orderStage === "NOT_DISPATCHED") {
    return { aiClassification: "AUTO_CANCEL_SAFE", initialStatus: "APPROVED", autoCancel: true };
  }

  if (orderStage === "IN_DISPATCH_PLAN_NOT_DEPARTED") {
    return { aiClassification: "NEEDS_REVIEW", initialStatus: "REQUESTED", autoCancel: false };
  }

  // DEPARTED_IN_TRANSIT / RECEIVED_PARTIAL / RECEIVED_FULL / DEPARTED_TERMINAL_OTHER
  return { aiClassification: "HOLD_AND_ALERT", initialStatus: "ON_HOLD", autoCancel: false };
}

export function mapResolutionToStatus(resolution: Resolution): RequestStatus {
  switch (resolution) {
    case "CANCEL_APPROVED":
      return "APPROVED";
    case "CANCEL_REJECTED":
      return "REJECTED";
    case "CANCELLED_NOT_ORDERED":
    case "ORDERED_BY_ANOTHER_PIC":
      return "RESOLVED";
    case "KEPT_ON_HOLD":
      return "ON_HOLD";
  }
}

/** Resolution yang berujung order dibatalkan (sales_orders.status = 'cancelled'). */
export function resolutionCancelsOrder(resolution: Resolution): boolean {
  return resolution === "CANCEL_APPROVED" || resolution === "CANCELLED_NOT_ORDERED";
}

export function validateCreateDisputeInput(input: {
  reasonCode: string;
  notes: string | null;
  contactSource: ContactSource;
}): string | null {
  if (!input.reasonCode || input.reasonCode.trim().length === 0) {
    return "Alasan wajib dipilih.";
  }
  if (input.reasonCode === "OTHER_REQUIRES_NOTE" && (!input.notes || input.notes.trim().length === 0)) {
    return "Catatan wajib diisi untuk alasan 'Lainnya'.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Owner alert policy (Langkah 5) — dampak bisnis, bukan daftar hardcode.
// ---------------------------------------------------------------------------

export interface OwnerAlertDecisionInput {
  requestType: RequestType;
  orderStage: OrderStage;
  orderValue: number;
  /** Kebijakan tenant (mis. companies.settings.high_value_order_threshold) — null = tidak dicek. */
  highValueThreshold: number | null;
  /** Berapa banyak request dispute/cancel dari PIC/nomor yang sama dalam window tertentu — dihitung repository. */
  recentDisputeCountForCustomer: number;
  /** TRUE bila resolution mengubah PIC (ORDERED_BY_ANOTHER_PIC) bersamaan dengan proses dispute. */
  picChangedDuringDispute: boolean;
}

const REPEAT_PATTERN_THRESHOLD = 2; // >= 2 request sebelumnya dari customer yang sama = pola berulang

export function requiresOwnerAlertForDispute(input: OwnerAlertDecisionInput): boolean {
  if (input.requestType === "CUSTOMER_DENIES_ORDER") return true;

  const cancelledAfterDispatch =
    input.requestType === "CUSTOMER_CANCELLED" && input.orderStage !== "NOT_DISPATCHED";
  if (cancelledAfterDispatch) return true;

  if (input.highValueThreshold !== null && input.orderValue >= input.highValueThreshold) return true;

  if (input.recentDisputeCountForCustomer >= REPEAT_PATTERN_THRESHOLD) return true;

  if (input.picChangedDuringDispute) return true;

  return false;
}

export interface DisputeAlertPayload {
  requestType: RequestType;
  orderReference: string;
  customerName: string;
  orderStage: string;
  reasonCode: string;
  reportedPicName: string | null;
  contactSource: string;
  actor: string;
  recommendation: string;
}

const RECOMMENDATION: Record<RequestType, string> = {
  CUSTOMER_CANCELLED: "Tinjau pembatalan ini — order sudah masuk proses pengiriman. Konfirmasi status barang sebelum melanjutkan.",
  CUSTOMER_DENIES_ORDER: "PIC menyatakan tidak pernah memesan — tinjau riwayat order/actor/PIC sebelum mengambil keputusan. Jangan langsung menyalahkan Salesman.",
};

export function buildDisputeAlertPayload(input: {
  requestType: RequestType;
  orderReference: string;
  customerName: string;
  orderStage: string;
  reasonCode: string;
  reportedPicName: string | null;
  contactSource: string;
  actor: string;
}): DisputeAlertPayload {
  return {
    ...input,
    recommendation: RECOMMENDATION[input.requestType],
  };
}
