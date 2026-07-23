// =============================================================================
// Document Engine -- domain error taxonomy. Builder/validator SELALU throw
// DocumentSourceError dengan kode eksplisit (bukan Error generik) supaya
// caller (route/action masa depan) bisa membedakan jenis penolakan tanpa
// mem-parsing pesan teks.
// =============================================================================

export type DocumentSourceErrorCode =
  | "ORDER_LINE_EMPTY"
  | "ORDER_LINE_FOREIGN"
  | "DELIVERY_ORDER_MISMATCH"
  | "COMPANY_MISMATCH"
  | "DELIVERY_LINE_FOREIGN"
  | "DELIVERY_NOT_BILLABLE"
  | "INVOICE_QUANTITY_EXCEEDS_VERIFIED"
  | "NO_BILLABLE_LINES"
  | "ORDER_NOT_FOUND"
  | "DELIVERY_NOT_FOUND"
  | "TENANT_CONTEXT_MISMATCH"
  | "ORDER_SOURCE_INCOMPLETE"
  | "DELIVERY_SOURCE_INCOMPLETE"
  /** sales_orders.payment_terms_days NULL -- ditegakkan terpisah dari ORDER_SOURCE_INCOMPLETE (kode sendiri per keputusan Founder 2026-07-23). */
  | "PAYMENT_TERMS_INCOMPLETE"
  // Target 2/3/4 (Document Numbering, Tenant Legal Identity, Persistence &
  // Versioning) -- lihat lib/document-engine/issuance-repository.ts + issuance.ts.
  | "COMPANY_PROFILE_INCOMPLETE"
  | "DELIVERY_ALREADY_ISSUED"
  | "DELIVERY_NOT_ISSUABLE"
  | "DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE"
  | "SUPERSEDES_DOCUMENT_NOT_FOUND"
  | "SUPERSEDES_DOCUMENT_NOT_ACTIVE"
  | "VERSION_SOURCE_MISMATCH"
  /** Kapasitas cetak LOCKED Founder 2026-07-23: maksimum 30 line item per dokumen (PO/Invoice). Ditolak eksplisit -- TIDAK ADA halaman lanjutan/font mengecil/overflow:hidden. */
  | "DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED";

export interface DocumentLineItemLimitExceededMetadata {
  actualCount: number;
  maxCount: number;
}

export class DocumentSourceError extends Error {
  public readonly code: DocumentSourceErrorCode;
  /** Metadata terstruktur opsional -- saat ini hanya diisi untuk DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED (actualCount/maxCount), supaya caller tidak perlu mem-parsing pesan teks. */
  public readonly metadata?: DocumentLineItemLimitExceededMetadata;

  constructor(code: DocumentSourceErrorCode, message: string, metadata?: DocumentLineItemLimitExceededMetadata) {
    super(message);
    this.name = "DocumentSourceError";
    this.code = code;
    this.metadata = metadata;
  }
}
