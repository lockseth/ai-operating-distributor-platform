// Domain badge -- satu component untuk seluruh status di aplikasi (Gate 2I.1
// GAP G7). domain default "sales_order" mempertahankan perilaku lama persis
// (caller existing yang tidak mengirim domain tidak berubah sama sekali).
// Setiap domain finance punya map TERPISAH (bukan satu map gabungan) karena
// status code yang SAMA berarti label berbeda antar domain -- mis. status
// "requested" adalah "Menunggu Verifikasi" untuk return tapi "Menunggu
// Persetujuan" untuk refund/cancellation (AODP_GATE_2I kontrak §5.5/§5.6/§5.7).

export type StatusDomain =
  | "sales_order"
  | "invoice"
  | "promise"
  | "payment_reconciliation"
  | "return"
  | "refund"
  | "cancellation"
  | "invoice_void"
  | "payment_claim";

interface StatusStyle {
  label: string;
  className: string;
}

const SALES_ORDER_STATUS_STYLES: Record<string, StatusStyle> = {
  pending:    { label: "Pending",     className: "bg-gray-100 text-gray-700" },
  confirmed:  { label: "Dikonfirmasi",className: "bg-blue-100 text-blue-700" },
  delivering: { label: "Dikirim",     className: "bg-amber-100 text-amber-700" },
  delivered:  { label: "Terkirim",    className: "bg-green-100 text-green-700" },
  invoiced:   { label: "Ditagih",     className: "bg-purple-100 text-purple-700" },
  paid:       { label: "Lunas",       className: "bg-green-100 text-green-800" },
  cancelled:  { label: "Dibatalkan",  className: "bg-red-100 text-red-700" },
};

const INVOICE_STATUS_STYLES: Record<string, StatusStyle> = {
  outstanding:    { label: "Belum Dibayar",    className: "bg-amber-100 text-amber-700" },
  partially_paid: { label: "Dibayar Sebagian", className: "bg-blue-100 text-blue-700" },
  paid:           { label: "Lunas",            className: "bg-green-100 text-green-800" },
};

const PROMISE_STATUS_STYLES: Record<string, StatusStyle> = {
  open:      { label: "Aktif",       className: "bg-blue-100 text-blue-700" },
  corrected: { label: "Dikoreksi",   className: "bg-gray-100 text-gray-700" },
  cancelled: { label: "Dibatalkan",  className: "bg-red-100 text-red-700" },
  broken:    { label: "Wanprestasi", className: "bg-red-100 text-red-700" },
};

const PAYMENT_RECONCILIATION_STATUS_STYLES: Record<string, StatusStyle> = {
  pending_verification: { label: "Menunggu Rekonsiliasi", className: "bg-amber-100 text-amber-700" },
  matched:              { label: "Cocok",                 className: "bg-green-100 text-green-800" },
  partially_matched:    { label: "Cocok Sebagian",         className: "bg-blue-100 text-blue-700" },
  unmatched:            { label: "Tidak Cocok",            className: "bg-red-100 text-red-700" },
  overpaid:             { label: "Kelebihan Bayar",        className: "bg-purple-100 text-purple-700" },
  shortpaid:            { label: "Kurang Bayar",           className: "bg-gray-100 text-gray-700" },
};

const RETURN_STATUS_STYLES: Record<string, StatusStyle> = {
  requested: { label: "Menunggu Verifikasi", className: "bg-amber-100 text-amber-700" },
  approved:  { label: "Disetujui",           className: "bg-green-100 text-green-800" },
  rejected:  { label: "Ditolak",             className: "bg-red-100 text-red-700" },
};

const REFUND_STATUS_STYLES: Record<string, StatusStyle> = {
  requested: { label: "Menunggu Persetujuan", className: "bg-amber-100 text-amber-700" },
  approved:  { label: "Disetujui",            className: "bg-green-100 text-green-800" },
  rejected:  { label: "Ditolak",              className: "bg-red-100 text-red-700" },
};

const CANCELLATION_STATUS_STYLES: Record<string, StatusStyle> = {
  requested: { label: "Menunggu Persetujuan", className: "bg-amber-100 text-amber-700" },
  approved:  { label: "Disetujui",            className: "bg-green-100 text-green-800" },
  rejected:  { label: "Ditolak",              className: "bg-red-100 text-red-700" },
};

const INVOICE_VOID_STATUS_STYLES: Record<string, StatusStyle> = {
  voided:   { label: "Invoice Void",         className: "bg-gray-100 text-gray-700" },
  reversed: { label: "Credit Note Direverse",className: "bg-gray-100 text-gray-700" },
};

const PAYMENT_CLAIM_STATUS_STYLES: Record<string, StatusStyle> = {
  PENDING:  { label: "Menunggu Review", className: "bg-amber-100 text-amber-700" },
  APPROVED: { label: "Disetujui",       className: "bg-green-100 text-green-800" },
  REJECTED: { label: "Ditolak",         className: "bg-red-100 text-red-700" },
};

const DOMAIN_STATUS_STYLES: Record<StatusDomain, Record<string, StatusStyle>> = {
  sales_order: SALES_ORDER_STATUS_STYLES,
  invoice: INVOICE_STATUS_STYLES,
  promise: PROMISE_STATUS_STYLES,
  payment_reconciliation: PAYMENT_RECONCILIATION_STATUS_STYLES,
  return: RETURN_STATUS_STYLES,
  refund: REFUND_STATUS_STYLES,
  cancellation: CANCELLATION_STATUS_STYLES,
  invoice_void: INVOICE_VOID_STATUS_STYLES,
  payment_claim: PAYMENT_CLAIM_STATUS_STYLES,
};

export function StatusBadge({ status, domain = "sales_order" }: { status: string; domain?: StatusDomain }) {
  const map = DOMAIN_STATUS_STYLES[domain];
  const style = map[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}
