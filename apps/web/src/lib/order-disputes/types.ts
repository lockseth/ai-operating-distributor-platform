// =============================================================================
// Order Cancellation & Dispute — kontrak tipe.
//
// Dua kejadian berbeda, tidak pernah hard delete order:
//   CUSTOMER_CANCELLED    — PIC mengakui pernah memesan, lalu membatalkan.
//   CUSTOMER_DENIES_ORDER — PIC menyatakan tidak pernah memesan.
// =============================================================================

export type RequestType = "CUSTOMER_CANCELLED" | "CUSTOMER_DENIES_ORDER";

export type ContactSource = "CUSTOMER_WHATSAPP" | "CUSTOMER_PHONE" | "FIELD_VISIT" | "OTHER";

export const CONTACT_SOURCE_LABEL: Record<ContactSource, string> = {
  CUSTOMER_WHATSAPP: "WhatsApp",
  CUSTOMER_PHONE: "Telepon",
  FIELD_VISIT: "Kunjungan",
  OTHER: "Lainnya",
};

export type OrderStage =
  | "NOT_DISPATCHED"
  | "IN_DISPATCH_PLAN_NOT_DEPARTED"
  | "DEPARTED_IN_TRANSIT"
  | "RECEIVED_PARTIAL"
  | "RECEIVED_FULL"
  | "DEPARTED_TERMINAL_OTHER";

export const ORDER_STAGE_LABEL: Record<OrderStage, string> = {
  NOT_DISPATCHED: "Belum Dispatch",
  IN_DISPATCH_PLAN_NOT_DEPARTED: "Dalam Rencana Kirim (Belum Berangkat)",
  DEPARTED_IN_TRANSIT: "Sudah Berangkat",
  RECEIVED_PARTIAL: "Diterima Sebagian",
  RECEIVED_FULL: "Diterima Penuh",
  DEPARTED_TERMINAL_OTHER: "Selesai Tanpa Diterima (Ditolak/Toko Tutup/Gagal)",
};

export type AiClassification = "AUTO_CANCEL_SAFE" | "NEEDS_REVIEW" | "HOLD_AND_ALERT";

export type RequestStatus = "REQUESTED" | "ON_HOLD" | "APPROVED" | "REJECTED" | "RESOLVED";

export type Resolution =
  | "CANCEL_APPROVED"
  | "CANCEL_REJECTED"
  | "CANCELLED_NOT_ORDERED"
  | "ORDERED_BY_ANOTHER_PIC"
  | "KEPT_ON_HOLD";

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  CANCEL_APPROVED: "Approve Pembatalan",
  CANCEL_REJECTED: "Reject Pembatalan",
  CANCELLED_NOT_ORDERED: "Konfirmasi Tidak Pernah Pesan",
  ORDERED_BY_ANOTHER_PIC: "Konfirmasi Dipesan PIC Lain",
  KEPT_ON_HOLD: "Tetap Ditahan (Hold)",
};

export const REASON_CODES: readonly string[] = [
  "CHANGE_OF_MIND",
  "PRICE_DISAGREEMENT",
  "DUPLICATE_ORDER",
  "WRONG_ITEMS",
  "FINANCIAL_ISSUE",
  "SUPPLIER_DELAY_UNACCEPTABLE",
  "NOT_ORDERED_BY_PIC",
  "OTHER_REQUIRES_NOTE",
];

export interface CreateDisputeRequestInput {
  companyId: string;
  salesOrderId: string;
  requestType: RequestType;
  reasonCode: string;
  notes: string | null;
  reportedPicName: string | null;
  reportedPicPhone: string | null;
  contactSource: ContactSource;
  requestedBy: string;
  idempotencyKey: string | null;
}

export type CreateDisputeRequestResult =
  | {
      outcome: "created" | "already_exists";
      requestId: string;
      orderStage: OrderStage;
      aiClassification: AiClassification;
      autoCancelled: boolean;
    }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "order_not_found" }
  | { outcome: "order_already_cancelled" }
  | { outcome: "already_has_active_request" }
  | { outcome: "unexpected_error"; error: string };

export interface ResolveDisputeRequestInput {
  companyId: string;
  requestId: string;
  reviewerId: string;
  resolution: Resolution;
  resolutionNotes: string | null;
  actualPicName: string | null;
}

export type ResolveDisputeRequestResult =
  | { outcome: "resolved"; newStatus: RequestStatus }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "not_found" }
  | { outcome: "self_review_forbidden" }
  | { outcome: "already_resolved"; currentStatus: RequestStatus }
  | { outcome: "unexpected_error"; error: string };

export interface DisputeRequestRecord {
  id: string;
  companyId: string;
  salesOrderId: string;
  requestType: RequestType;
  reasonCode: string;
  notes: string | null;
  reportedPicName: string | null;
  reportedPicPhone: string | null;
  contactSource: ContactSource;
  orderStageAtRequest: OrderStage;
  aiClassification: AiClassification | null;
  status: RequestStatus;
  resolution: Resolution | null;
  resolutionNotes: string | null;
  actualPicName: string | null;
  requestedBy: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
