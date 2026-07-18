// =============================================================================
// Legacy Data Onboarding & Import Foundation — kontrak tipe.
//
// 5 domain MVP (LANGKAH 2): CUSTOMER_PIC, PRODUCT_PRICE, OPEN_AR, OPEN_ORDER,
// HISTORICAL_ORDER. XLSX dan HISTORICAL_PAYMENT/HISTORICAL_RETURN di-scope
// keluar gate ini (tidak ada parser XLSX aman tersedia; tidak ada schema
// payment/return native) -- lihat migration
// 20260801000001_legacy_import_foundation.sql untuk detail audit.
// =============================================================================

export type ImportType = "CUSTOMER_PIC" | "PRODUCT_PRICE" | "OPEN_AR" | "OPEN_ORDER" | "HISTORICAL_ORDER";

export const IMPORT_TYPES: readonly ImportType[] = [
  "CUSTOMER_PIC", "PRODUCT_PRICE", "OPEN_AR", "OPEN_ORDER", "HISTORICAL_ORDER",
];

export const IMPORT_TYPE_LABEL: Record<ImportType, string> = {
  CUSTOMER_PIC: "Pelanggan & PIC",
  PRODUCT_PRICE: "Produk & Harga",
  OPEN_AR: "Piutang Terbuka (Open AR)",
  OPEN_ORDER: "Order Terbuka (Open Order)",
  HISTORICAL_ORDER: "Riwayat Order (Historical Order)",
};

export type ImportBatchStatus =
  | "UPLOADED" | "MAPPED" | "VALIDATED" | "READY_TO_COMMIT"
  | "COMMITTED" | "FAILED" | "ROLLED_BACK";

export type RowValidationStatus = "VALID" | "WARNING" | "DUPLICATE" | "ERROR";

export type ProposedAction = "CREATE" | "UPDATE" | "SKIP_DUPLICATE" | "NEEDS_REVIEW";

export interface ColumnMapping {
  sourceColumn: string;
  targetField: string;
}

export interface RowFieldError {
  field: string;
  message: string;
}

export interface ImportBatch {
  id: string;
  companyId: string;
  importType: ImportType;
  sourceSystem: string;
  originalFilename: string;
  fileHash: string;
  status: ImportBatchStatus;
  columnMappings: ColumnMapping[];
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  duplicateRows: number;
  reconciliation: ReconciliationSummary | Record<string, never>;
  commitResult: { createdCount?: number; updatedCount?: number } | Record<string, never>;
  failureReason: string | null;
  rollbackReason: string | null;
  createdBy: string;
  createdAt: string;
  mappedAt: string | null;
  validatedAt: string | null;
  committedAt: string | null;
  rolledBackAt: string | null;
}

export interface ImportBatchRow {
  id: string;
  batchId: string;
  companyId: string;
  rowNumber: number;
  rawData: Record<string, string>;
  normalizedData: Record<string, unknown>;
  validationStatus: RowValidationStatus;
  errors: RowFieldError[];
  warnings: RowFieldError[];
  detectedExistingId: string | null;
  proposedAction: ProposedAction;
  rowHash: string;
  committedEntityId: string | null;
  committedEntityTable: string | null;
}

export interface ReconciliationSummary {
  sourceTotal: number;
  importTotal: number;
  excludedTotal: number;
  difference: number;
  toleranceUsed: number;
  withinTolerance: boolean;
}

export interface RollbackBlocker {
  rowNumber: number;
  entityTable: string;
  entityId: string;
  reason: string;
}

// -----------------------------------------------------------------------
// Domain field schema — dipakai untuk template download, mapping-suggestion,
// dan required-field validation. `key` adalah target_field canonical yang
// dipakai normalizedData & commit RPC (harus tetap sinkron dengan SQL di
// migration 20260801000002_legacy_import_commit_rollback.sql).
// -----------------------------------------------------------------------

export interface DomainField {
  key: string;
  label: string;
  required: boolean;
  type: "text" | "phone" | "email" | "date" | "currency" | "number" | "boolean" | "roles";
  example: string;
  aliases: readonly string[]; // untuk deterministic mapping suggestion (LANGKAH 6)
}

export const DOMAIN_FIELDS: Record<ImportType, readonly DomainField[]> = {
  CUSTOMER_PIC: [
    { key: "store_legacy_code", label: "Kode Toko Lama", required: true, type: "text", example: "TK-0001",
      aliases: ["kode toko", "customer code", "store code", "kode pelanggan", "kode outlet"] },
    { key: "store_name", label: "Nama Toko", required: true, type: "text", example: "Toko Sinar Jaya",
      aliases: ["nama outlet", "nama toko", "customer name", "store name", "nama pelanggan"] },
    { key: "store_phone", label: "Nomor Telepon Toko", required: false, type: "phone", example: "081234567890",
      aliases: ["nomor hp", "no telp", "phone", "telepon toko"] },
    { key: "store_address", label: "Alamat", required: false, type: "text", example: "Jl. Merdeka No. 1",
      aliases: ["alamat", "address"] },
    { key: "store_area", label: "Area/Wilayah", required: false, type: "text", example: "Jakarta Selatan",
      aliases: ["area", "wilayah", "region"] },
    { key: "assigned_salesman_name", label: "Sales Penanggung Jawab", required: false, type: "text", example: "Budi Santoso",
      aliases: ["sales to", "salesman", "sales", "assigned salesman", "nama sales"] },
    { key: "pic_name", label: "Nama PIC", required: true, type: "text", example: "Siti Aminah",
      aliases: ["nama pic", "pic name", "contact person", "nama kontak"] },
    { key: "pic_phone", label: "Nomor HP PIC", required: true, type: "phone", example: "081298765432",
      aliases: ["no hp pic", "pic phone", "nomor pic"] },
    { key: "pic_email", label: "Email PIC (opsional)", required: false, type: "email", example: "siti@example.com",
      aliases: ["email pic", "pic email", "email"] },
    { key: "pic_roles", label: "Peran PIC (pisah koma: OWNER,ORDERER,RECEIVER,PAYMENT_CONTACT,BACKUP_CONTACT)", required: true, type: "roles", example: "OWNER",
      aliases: ["peran", "role", "pic role", "jabatan"] },
    { key: "is_active", label: "Aktif", required: false, type: "boolean", example: "TRUE",
      aliases: ["aktif", "status", "active"] },
  ],
  PRODUCT_PRICE: [
    { key: "product_legacy_code", label: "Kode Produk Lama", required: true, type: "text", example: "PRD-001",
      aliases: ["kode produk", "product code", "legacy code"] },
    { key: "sku", label: "SKU", required: true, type: "text", example: "SBN-CAIR-500ML",
      aliases: ["sku", "kode sku"] },
    { key: "name", label: "Nama Produk", required: true, type: "text", example: "Sabun Cair 500ml",
      aliases: ["nama produk", "product name", "nama barang"] },
    { key: "unit", label: "Satuan", required: false, type: "text", example: "dus",
      aliases: ["satuan", "unit", "uom"] },
    { key: "price", label: "Harga", required: true, type: "currency", example: "Rp 45.000",
      aliases: ["harga", "price", "harga jual"] },
    { key: "is_active", label: "Aktif", required: false, type: "boolean", example: "TRUE",
      aliases: ["aktif", "status", "active"] },
  ],
  OPEN_AR: [
    { key: "legacy_invoice_number", label: "Nomor Invoice Lama", required: true, type: "text", example: "INV-2026-0001",
      aliases: ["no invoice", "invoice number", "nomor faktur"] },
    { key: "customer_legacy_code", label: "Kode Toko/Pelanggan", required: true, type: "text", example: "TK-0001",
      aliases: ["kode toko", "customer code", "kode pelanggan"] },
    { key: "invoice_date", label: "Tanggal Invoice", required: true, type: "date", example: "01/07/2026",
      aliases: ["tanggal invoice", "invoice date", "tgl faktur"] },
    { key: "due_date", label: "Jatuh Tempo", required: false, type: "date", example: "31/07/2026",
      aliases: ["jatuh tempo", "due date", "tgl jatuh tempo"] },
    { key: "original_amount", label: "Nilai Awal", required: true, type: "currency", example: "Rp 5.000.000",
      aliases: ["nilai invoice", "original amount", "total tagihan"] },
    { key: "amount_paid", label: "Sudah Dibayar", required: true, type: "currency", example: "Rp 2.000.000",
      aliases: ["sudah dibayar", "amount paid", "dibayar"] },
    { key: "outstanding_balance", label: "Sisa Saldo (Outstanding)", required: true, type: "currency", example: "Rp 3.000.000",
      aliases: ["saldo", "outstanding", "sisa tagihan", "sisa piutang"] },
    { key: "payment_terms", label: "Termin Pembayaran", required: false, type: "text", example: "NET 30",
      aliases: ["termin", "payment terms", "syarat bayar"] },
    { key: "assigned_salesman_name", label: "Sales Penanggung Jawab", required: false, type: "text", example: "Budi Santoso",
      aliases: ["sales to", "salesman", "sales"] },
  ],
  OPEN_ORDER: [
    { key: "legacy_order_number", label: "Nomor Order Lama", required: true, type: "text", example: "SO-2026-0001",
      aliases: ["no order", "order number", "nomor po"] },
    { key: "customer_legacy_code", label: "Kode Toko/Pelanggan", required: true, type: "text", example: "TK-0001",
      aliases: ["kode toko", "customer code"] },
    { key: "order_date", label: "Tanggal Order", required: true, type: "date", example: "01/07/2026",
      aliases: ["tanggal order", "order date", "tgl order"] },
    { key: "product_legacy_code", label: "Kode Produk", required: true, type: "text", example: "PRD-001",
      aliases: ["kode produk", "product code", "sku"] },
    { key: "quantity", label: "Kuantitas", required: true, type: "number", example: "10",
      aliases: ["qty", "quantity", "jumlah"] },
    { key: "unit_price", label: "Harga Satuan", required: true, type: "currency", example: "Rp 45.000",
      aliases: ["harga satuan", "unit price", "harga"] },
    { key: "discount", label: "Diskon", required: false, type: "currency", example: "Rp 0",
      aliases: ["diskon", "discount"] },
    { key: "total", label: "Total", required: true, type: "currency", example: "Rp 450.000",
      aliases: ["total", "jumlah total", "subtotal"] },
    { key: "outstanding_delivery_quantity", label: "Sisa Kirim (Outstanding Qty)", required: false, type: "number", example: "5",
      aliases: ["sisa kirim", "outstanding qty", "belum terkirim"] },
    { key: "status", label: "Status", required: false, type: "text", example: "confirmed",
      aliases: ["status", "status order"] },
  ],
  HISTORICAL_ORDER: [
    { key: "legacy_order_number", label: "Nomor Order", required: true, type: "text", example: "SO-2025-0001",
      aliases: ["no order", "order number"] },
    { key: "customer_legacy_code", label: "Kode Toko/Pelanggan", required: true, type: "text", example: "TK-0001",
      aliases: ["kode toko", "customer code"] },
    { key: "order_date", label: "Tanggal Order", required: true, type: "date", example: "01/03/2025",
      aliases: ["tanggal order", "order date"] },
    { key: "salesman_name", label: "Sales", required: false, type: "text", example: "Budi Santoso",
      aliases: ["sales", "salesman", "nama sales"] },
    { key: "product_legacy_code", label: "Kode Produk", required: true, type: "text", example: "PRD-001",
      aliases: ["kode produk", "product code", "sku"] },
    { key: "quantity", label: "Kuantitas", required: true, type: "number", example: "10",
      aliases: ["qty", "quantity", "jumlah"] },
    { key: "unit_price", label: "Harga Satuan", required: true, type: "currency", example: "Rp 45.000",
      aliases: ["harga satuan", "unit price"] },
    { key: "total_value", label: "Nilai Total", required: true, type: "currency", example: "Rp 450.000",
      aliases: ["nilai total", "total value", "total"] },
    { key: "final_status", label: "Status Akhir (delivered/paid/cancelled)", required: true, type: "text", example: "paid",
      aliases: ["status akhir", "final status", "status"] },
  ],
};
