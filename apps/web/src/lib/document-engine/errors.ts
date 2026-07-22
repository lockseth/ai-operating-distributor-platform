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
  // Target 2/3/4 (Document Numbering, Tenant Legal Identity, Persistence &
  // Versioning) -- lihat lib/document-engine/issuance-repository.ts + issuance.ts.
  | "COMPANY_PROFILE_INCOMPLETE"
  | "DELIVERY_ALREADY_ISSUED"
  | "DELIVERY_NOT_ISSUABLE"
  | "DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE"
  | "SUPERSEDES_DOCUMENT_NOT_FOUND"
  | "SUPERSEDES_DOCUMENT_NOT_ACTIVE"
  | "VERSION_SOURCE_MISMATCH";

export class DocumentSourceError extends Error {
  public readonly code: DocumentSourceErrorCode;

  constructor(code: DocumentSourceErrorCode, message: string) {
    super(message);
    this.name = "DocumentSourceError";
    this.code = code;
  }
}
