// =============================================================================
// Gate 2I.2 -- Pemetaan kode error RPC Gate 2C/2D/2E ke pesan Indonesia yang
// manusiawi (kontrak §5: "RPC error code asli tidak boleh bocor mentah ke
// UI"). Dipisah dari actions.ts (file "use server", seluruh export top-level
// wajib async function) supaya pure mapping ini bisa diuji langsung tanpa
// mock Next.js request context.
// =============================================================================

export const FINANCE_ERROR_MESSAGES: Record<string, string> = {
  FORBIDDEN: "Anda tidak memiliki izin untuk melakukan aksi ini.",
  TENANT_CONTEXT_MISMATCH: "Data tidak ditemukan pada perusahaan Anda.",
  REASON_REQUIRED: "Alasan wajib diisi.",
  INVALID_PROMISED_AMOUNT: "Nominal janji bayar harus lebih besar dari nol.",
  AMOUNT_EXCEEDS_OUTSTANDING: "Nominal melebihi sisa piutang invoice saat ini. Data mungkin sudah berubah, silakan muat ulang.",
  PROMISE_DATE_IN_PAST: "Tanggal janji bayar tidak boleh di masa lalu.",
  ACTIVE_PROMISE_EXISTS: "Invoice ini sudah memiliki janji bayar aktif.",
  NOOP_CORRECTION_REJECTED: "Tidak ada perubahan pada koreksi ini.",
  PROMISE_NOT_YET_DUE: "Janji bayar belum melewati tanggal jatuh tempo.",
  REPORTED_AMOUNT_NOT_APPLICABLE: "Nominal klaim hanya berlaku untuk klaim bayar sebagian/lunas.",
  INVALID_OUTCOME_RESERVED: "Hasil aktivitas ini hanya dapat dibuat lewat alur janji bayar.",
  PROOF_REQUIRED: "Minimal satu bukti pembayaran wajib dilampirkan.",
  INVALID_PROOF: "Bukti pembayaran tidak lengkap.",
  ALLOCATION_TOTAL_MISMATCH: "Total alokasi harus sama dengan nominal pembayaran.",
  ALLOCATION_REQUIRED: "Minimal satu alokasi invoice wajib diisi.",
  ALLOCATION_EXCEEDS_OUTSTANDING: "Alokasi melebihi sisa piutang invoice. Data telah berubah, silakan muat ulang.",
  DUPLICATE_INVOICE_IN_ALLOCATION: "Satu invoice tidak boleh muncul dua kali dalam satu alokasi.",
  INVOICE_CUSTOMER_MISMATCH: "Seluruh invoice dalam satu pembayaran harus milik customer yang sama.",
  DUPLICATE_TRANSFER_REFERENCE: "Nomor referensi transfer ini sudah pernah dicatat sebelumnya.",
  IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: "Permintaan sebelumnya dengan data berbeda sudah diproses. Muat ulang halaman dan coba lagi.",
  IDEMPOTENCY_KEY_PAYMENT_MISMATCH: "Permintaan sebelumnya untuk pembayaran lain sudah diproses. Muat ulang halaman dan coba lagi.",
  PAYMENT_RECEIPT_NOT_FOUND: "Bukti pembayaran tidak ditemukan.",

  // Gate 2F -- Retur & Credit Note (request_return_atomic/verify_return_atomic).
  REASON_CODE_REQUIRED: "Alasan retur wajib diisi.",
  ITEMS_REQUIRED: "Retur wajib menyertakan minimal satu item.",
  INVALID_ITEM_QUANTITY: "Kuantitas setiap item retur harus lebih besar dari nol.",
  DUPLICATE_INVOICE_LINE_IN_RETURN: "Satu baris invoice tidak boleh muncul dua kali dalam satu retur.",
  INVOICE_LINE_NOT_IN_INVOICE: "Item retur tidak sesuai dengan invoice yang dipilih.",
  INVOICE_NOT_FOUND: "Invoice tidak ditemukan.",
  RETURN_NOT_FOUND: "Retur tidak ditemukan.",
  RETURN_ALREADY_RESOLVED: "Retur ini sudah diputuskan sebelumnya. Muat ulang halaman untuk melihat status terbaru.",
  RETURN_INVALID_TRANSITION: "Transisi status retur tidak valid.",
  RETURN_QUANTITY_EXCEEDS_CREDITABLE:
    "Kuantitas retur melebihi sisa yang dapat dikreditkan pada baris invoice ini. Data mungkin sudah berubah, silakan muat ulang.",
  RETURN_NO_CREDITABLE_ITEMS: "Retur ini tidak menghasilkan nilai kredit apa pun.",
  INVALID_DECISION: "Keputusan tidak valid.",

  // Gate 2H -- Customer Credit & Refund (request_refund_atomic/approve_refund_atomic).
  INVALID_REFUND_AMOUNT: "Nominal refund harus lebih besar dari nol.",
  INVALID_METHOD: "Metode refund tidak valid.",
  TRANSACTION_DATE_REQUIRED: "Tanggal transaksi wajib diisi.",
  CREDIT_NOTE_NOT_FOUND: "Credit note tidak ditemukan.",
  CREDIT_NOTE_REVERSED: "Credit note ini sudah direverse dan tidak dapat menjadi sumber refund.",
  REFUND_EXCEEDS_AVAILABLE_BALANCE:
    "Nominal refund melebihi saldo tersedia pada credit note ini. Data mungkin sudah berubah, silakan muat ulang.",
  REFUND_ALREADY_RESOLVED: "Refund ini sudah diputuskan sebelumnya. Muat ulang halaman untuk melihat status terbaru.",
  REFUND_NOT_FOUND: "Refund tidak ditemukan.",

  // Gate 2G -- Order Cancellation & Invoice Void (request_order_cancellation_atomic/approve_order_cancellation_atomic).
  ORDER_NOT_FOUND: "Order tidak ditemukan.",
  ORDER_ALREADY_CANCELLED: "Order ini sudah berstatus dibatalkan.",
  ORDER_CANCELLATION_ALREADY_REQUESTED: "Order ini sudah memiliki pengajuan pembatalan yang belum diputuskan.",
  ORDER_CANCELLATION_NOT_FOUND: "Pengajuan pembatalan tidak ditemukan.",
  ORDER_CANCELLATION_ALREADY_RESOLVED: "Pengajuan ini sudah diputuskan sebelumnya. Muat ulang halaman untuk melihat status terbaru.",
  DELIVERY_REVERSAL_REQUIRED: "Order sudah terkirim — pembatalan memerlukan reversal delivery terlebih dahulu (belum didukung).",
  INVOICE_RECORD_MISSING: "Order ini tidak memiliki data invoice yang valid untuk diproses.",
  MULTIPLE_INVOICES_UNSUPPORTED: "Order ini memiliki lebih dari satu invoice — belum didukung.",
  INVOICE_SETTLEMENT_EXISTS: "Invoice sudah memiliki pembayaran atau credit note aktif — pembatalan dengan invoice void tidak dapat dilakukan.",
  INVALID_ORDER_STATUS_FOR_CANCELLATION: "Status order saat ini tidak dapat diproses untuk pembatalan.",

  // Gate P4.06 -- Klaim Pembayaran (submit_payment_claim_atomic/approve_payment_claim_atomic/reject_payment_claim_atomic).
  INVALID_AMOUNT: "Nominal harus lebih besar dari nol.",
  CUSTOMER_NOT_FOUND: "Customer tidak ditemukan.",
  PAYMENT_CLAIM_NOT_FOUND: "Klaim pembayaran tidak ditemukan.",
  PAYMENT_CLAIM_ALREADY_DECIDED: "Klaim ini sudah diputuskan sebelumnya. Muat ulang halaman untuk melihat status terbaru.",
  PAYMENT_CLAIM_CORE_IMMUTABLE: "Data klaim tidak dapat diubah setelah dikirim.",
  PAYMENT_CLAIM_IMMUTABLE: "Klaim pembayaran tidak dapat dihapus.",
  ALLOCATION_CUSTOMER_MISMATCH: "Invoice yang dipilih bukan milik customer pada klaim ini.",
};

const DEFAULT_FINANCE_ERROR_MESSAGE = "Terjadi kesalahan saat memproses permintaan.";

export function mapFinanceRpcError(message: string): string {
  for (const [code, human] of Object.entries(FINANCE_ERROR_MESSAGES)) {
    if (message.includes(code)) return human;
  }
  return DEFAULT_FINANCE_ERROR_MESSAGE;
}
