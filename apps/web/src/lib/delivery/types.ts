// =============================================================================
// Delivery Verification — domain types.
// Kontrak ini mengikuti AODP Waluyo Living Knowledge Pack v1.0 §4.2/§5 dan
// Delivery Verification Implementation Gate — TIDAK menambah konsep di luar
// yang dikunci di dua dokumen tersebut.
// =============================================================================

export type DeliveryStatus =
  | "planned"
  | "dispatched"
  | "arrived"
  | "fully_received"
  | "partially_received"
  | "rejected"
  | "store_closed"
  | "failed"
  | "verified";

/** Status terminal: tidak ada transisi lebih lanjut, invoice eligibility final. */
export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "fully_received",
  "partially_received",
  "rejected",
  "store_closed",
  "failed",
  "verified",
];

export function isTerminalStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

/** Hasil yang dipilih driver — dipetakan ke DeliveryStatus oleh service layer. */
export type DeliveryOutcome = "full" | "partial" | "rejected" | "store_closed" | "failed";

export type ReasonCode =
  | "STORE_CLOSED"
  | "CUSTOMER_PARTIAL_ACCEPTANCE"
  | "CUSTOMER_REJECTED"
  | "ITEM_DAMAGED"
  | "ITEM_MISMATCH"
  | "QUANTITY_MISMATCH"
  | "PRICE_OR_DISCOUNT_DISPUTE"
  | "RECIPIENT_NOT_AUTHORIZED"
  | "ADDRESS_NOT_FOUND"
  | "VEHICLE_OR_DRIVER_ISSUE"
  | "OTHER_REQUIRES_NOTE";

export const REASON_CODES: readonly ReasonCode[] = [
  "STORE_CLOSED",
  "CUSTOMER_PARTIAL_ACCEPTANCE",
  "CUSTOMER_REJECTED",
  "ITEM_DAMAGED",
  "ITEM_MISMATCH",
  "QUANTITY_MISMATCH",
  "PRICE_OR_DISCOUNT_DISPUTE",
  "RECIPIENT_NOT_AUTHORIZED",
  "ADDRESS_NOT_FOUND",
  "VEHICLE_OR_DRIVER_ISSUE",
  "OTHER_REQUIRES_NOTE",
];

export type EvidenceType = "photo" | "signature" | "voice_note" | "location" | "note";
export type ExceptionSeverity = "low" | "medium" | "high";
export type ExceptionResolutionStatus = "open" | "resolved" | "wont_fix";

export interface DeliveryItemRecord {
  id: string;
  salesOrderItemId: string;
  productName: string;
  /** products.sku -- null bila item tanpa product_id/produk tanpa sku. Optional untuk kompatibilitas fixture test lama (jangan dikarang bila absen -- diperlakukan sebagai null). */
  productCode?: string | null;
  /** product_categories.name (jenis produk) -- null bila belum ada kategori. Optional, lihat catatan productCode. */
  productType?: string | null;
  unit: string | null;
  unitPrice: number;
  orderedQuantity: number;
  dispatchedQuantity: number;
  receivedQuantity: number;
  rejectedQuantity: number;
  returnedQuantity: number;
  unresolvedQuantity: number;
}

export interface DeliveryEvidenceInput {
  evidenceType: EvidenceType;
  storageRef: string;
  capturedAt?: string;
  latitude?: number | null;
  longitude?: number | null;
  deliveryItemId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DeliveryEvidenceRecord extends DeliveryEvidenceInput {
  id: string;
  actorId: string | null;
}

export interface DeliveryExceptionInput {
  reasonCode: ReasonCode;
  note?: string | null;
  severity: ExceptionSeverity;
  deliveryItemId?: string | null;
}

export interface DeliveryExceptionRecord extends DeliveryExceptionInput {
  id: string;
  resolutionStatus: ExceptionResolutionStatus;
  actorId: string | null;
  createdAt: string;
}

export interface RecipientInput {
  recipientName: string;
  identityNote?: string | null;
  isExpectedPic: boolean;
  signatureEvidenceId?: string | null;
}

export interface DeliveryRecord {
  id: string;
  companyId: string;
  salesOrderId: string;
  attemptNumber: number;
  assignedDriverId: string | null;
  status: DeliveryStatus;
  items: DeliveryItemRecord[];
  exceptions: DeliveryExceptionRecord[];
  evidence: DeliveryEvidenceRecord[];
  recipient: RecipientInput | null;
  /**
   * Nomor Surat Jalan -- dialokasikan HANYA lewat issue_delivery_note() RPC
   * (Target 2, migration 20260812000001), sebelum dispatch. NULL untuk
   * delivery yang belum diterbitkan/historis. Immutable setelah terisi.
   */
  deliveryNumber: string | null;
  /** Tanggal bisnis Asia/Jakarta saat Surat Jalan diterbitkan -- lihat deliveryNumber. NULL bila belum diterbitkan. */
  deliveryDate: string | null;
}

/** Per-item outcome yang dicatat driver saat outcome bukan "full". */
export interface ItemOutcomeInput {
  deliveryItemId: string;
  receivedQuantity: number;
  rejectedQuantity: number;
  returnedQuantity: number;
  unresolvedQuantity: number;
}

export interface ItemDiscrepancy {
  deliveryItemId: string;
  salesOrderItemId: string;
  productName: string;
  dispatchedQuantity: number;
  receivedQuantity: number;
  discrepancyQuantity: number;
  discrepancyValue: number;
  hasDiscrepancy: boolean;
}

export interface InvoiceEligibilityItem {
  salesOrderItemId: string;
  deliveryItemId: string;
  productName: string;
  /** products.sku -- null bila item tanpa product_id/produk tanpa sku (jangan dikarang). */
  productCode: string | null;
  /** product_categories.name (jenis produk) -- null bila belum ada kategori (jangan dikarang). */
  productType: string | null;
  eligibleQuantity: number;
  unitPrice: number;
  eligibleValue: number;
}

/**
 * Kontrak yang dikonsumsi tahap Invoice berikutnya. TIDAK membuat invoice —
 * murni query/derivasi dari verified received quantity (Implementation Gate §9).
 */
export interface InvoiceEligibility {
  deliveryId: string;
  salesOrderId: string;
  status: DeliveryStatus;
  isFinal: boolean;
  items: InvoiceEligibilityItem[];
  totalEligibleValue: number;
  totalOrderedValue: number;
  varianceValue: number;
}

export interface AggregateInvoiceEligibilityItem {
  salesOrderItemId: string;
  productName: string;
  orderedQuantity: number;
  aggregateReceivedQuantity: number;
  eligibleQuantity: number;
  unitPrice: number;
  eligibleValue: number;
  /**
   * TRUE hanya bila aggregateReceivedQuantity > orderedQuantity -- yaitu
   * SUM received_quantity lintas delivery attempt melebihi yang dipesan.
   * Ini seharusnya TIDAK PERNAH terjadi (dicegah atomic di
   * finalize_delivery_item_quantities), jadi flag ini adalah alarm integritas
   * data, bukan kondisi normal. eligibleQuantity tetap di-cap ke
   * orderedQuantity (tidak pernah melebihi), tapi flag ini SENGAJA tidak
   * disembunyikan -- konsumen (mis. Invoice) wajib menampilkan/menolak bila true.
   */
  dataIntegrityWarning: boolean;
}

/** Invoice eligibility lintas SELURUH delivery attempt milik satu sales_order (bukan satu delivery). */
export interface AggregateInvoiceEligibility {
  salesOrderId: string;
  items: AggregateInvoiceEligibilityItem[];
  totalEligibleValue: number;
  totalOrderedValue: number;
  hasDataIntegrityWarning: boolean;
}

export interface OwnerAlertPayload {
  customerName: string;
  orderReference: string;
  status: string;
  orderedValue: number;
  acceptedValue: number;
  varianceValue: number;
  reason: string;
  evidenceSummary: string;
  actor: string;
  recommendation: string;
}
