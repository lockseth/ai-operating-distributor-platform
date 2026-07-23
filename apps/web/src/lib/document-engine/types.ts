// =============================================================================
// AODP Document Engine -- domain contracts.
//
// Modul ini SENGAJA terisolasi: tipe di sini BUKAN reexport dari
// lib/sales-orders atau lib/delivery. Document Engine mendefinisikan
// kontrak eksplisit MILIKNYA SENDIRI untuk "apa yang dibutuhkan dari Order/
// Delivery" -- adapter yang memetakan baris sales_orders/deliveries nyata ke
// bentuk ini adalah pekerjaan terpisah (live repository adapter), belum
// dibuat pada gate ini (lihat laporan akhir untuk alasan eksplisit).
//
// Prinsip (docs/document-engine/constitution/AODP_DOCUMENT_CONSTITUTION_v1.0.md):
// Single Source of Truth, Immutable Snapshot, Server-side calculation,
// Tenant isolation. Branding TIDAK di-hardcode di sini -- TenantIdentity
// selalu berasal dari input supaya Document Engine tetap multi-tenant sah;
// PT Sumber Warna Alam Sudiada adalah data uji/tenant nyata pertama, bukan
// konstanta global.
// =============================================================================

export type DocumentType = "PURCHASE_ORDER" | "INVOICE";

export interface TenantIdentity {
  companyId: string;
  companyName: string;
  companyAddress: string;
  companyEmail: string;
  companyPhone: string;
  /** Opsional -- path/URL aset logo. Renderer tidak menampilkan apa pun bila null. */
  logoUrl: string | null;
}

export interface StoreIdentity {
  customerId: string;
  /** customers.code -- null bila tidak tersedia (jangan dikarang). */
  storeCode: string | null;
  storeName: string;
  storeAddress: string | null;
  /** customers.phone -- null bila tidak tersedia (jangan dikarang). */
  storePhone: string | null;
  /** PIC/penerima toko -- null bila belum tersedia (jangan dikarang). */
  picName: string | null;
}

export interface SalesmanIdentity {
  salesmanId: string;
  salesmanName: string;
}

/**
 * Satu baris item Order -- komponen mentah (quantity/unitPrice/discount),
 * BUKAN lineTotal siap pakai -- lineTotal SELALU dihitung monetary.ts supaya
 * tidak ada dua sumber kebenaran untuk angka yang sama.
 */
export interface OrderLineSource {
  orderLineId: string;
  productCode: string | null;
  productName: string;
  productType: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

export interface OrderSource {
  orderId: string;
  companyId: string;
  orderNumber: string;
  /** ISO date/datetime -- tanggal order, dipakai apa adanya (tidak dihitung ulang). */
  orderDate: string;
  store: StoreIdentity;
  salesman: SalesmanIdentity;
  lines: OrderLineSource[];
  /** Termin pembayaran dalam hari, null bila tidak ada (jangan dikarang jadi 0). */
  paymentTermsDays: number | null;
}

/**
 * Satu baris item Delivery. verifiedQuantity = kuantitas yang SUDAH
 * diverifikasi diterima (bukan ordered, bukan dispatched) -- mengikuti
 * konsep InvoiceEligibility pada lib/delivery/types.ts (dibaca sebagai
 * referensi kontrak, TIDAK diimpor -- lihat catatan modul di atas).
 */
export interface DeliveryLineSource {
  deliveryLineId: string;
  /** WAJIB merujuk OrderLineSource.orderLineId pada order yang sama. */
  orderLineId: string;
  productCode: string | null;
  productName: string;
  productType: string | null;
  unit: string | null;
  orderedQuantity: number;
  /** Kuantitas terverifikasi diterima -- SATU-SATUNYA dasar penagihan Invoice. */
  verifiedQuantity: number;
  unitPrice: number;
  /** Diskon proporsional untuk verifiedQuantity (bukan diskon atas orderedQuantity). */
  discountAmount: number;
}

/**
 * Status penagihan delivery ini -- setara konsep DeliveryStatus terminal
 * pada lib/delivery/types.ts (isTerminalStatus), diringkas jadi dua nilai
 * eksplisit di sini supaya Document Engine tidak perlu mengetahui seluruh
 * enum status delivery internal.
 */
export type DeliveryBillingStatus = "ELIGIBLE" | "NOT_YET_ELIGIBLE";

export interface DeliverySource {
  deliveryId: string;
  companyId: string;
  /** WAJIB sama dengan OrderSource.orderId pada Invoice yang sama. */
  orderId: string;
  deliveryNumber: string;
  deliveryDate: string;
  billingStatus: DeliveryBillingStatus;
  lines: DeliveryLineSource[];
}

// ---------------------------------------------------------------------------
// Output: document snapshot (immutable, deterministik).
// ---------------------------------------------------------------------------

export interface DocumentLineSnapshot {
  no: number;
  productCode: string | null;
  productName: string;
  productType: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  /** = quantity * unitPrice - discountAmount, dihitung SEKALI oleh monetary.ts. */
  lineTotal: number;
}

export interface DocumentTotals {
  /** Sum(quantity * unitPrice) SEBELUM diskon. */
  subtotal: number;
  /** Sum(discountAmount). */
  totalDiscount: number;
  /** subtotal - totalDiscount === Sum(lineTotal). */
  grandTotal: number;
}

export interface DocumentSignatures {
  salesmanName: string;
  /** Nama pengirim -- boleh sama dengan salesman (salesman merangkap pengirim), tetap dua area terpisah. */
  delivererName: string;
}

export interface DocumentSnapshot {
  documentType: DocumentType;
  documentNumber: string;
  documentDate: string;
  companyId: string;
  tenant: TenantIdentity;
  store: StoreIdentity;
  salesman: SalesmanIdentity;
  orderReference: string;
  /** Nomor delivery -- hanya diisi untuk Invoice, null untuk Purchase Order. */
  deliveryReference: string | null;
  paymentTermsDays: number | null;
  lines: DocumentLineSnapshot[];
  totals: DocumentTotals;
  signatures: DocumentSignatures;
  /** ISO timestamp -- kapan snapshot ini dibangun (bukan documentDate). */
  generatedAt: string;
}
