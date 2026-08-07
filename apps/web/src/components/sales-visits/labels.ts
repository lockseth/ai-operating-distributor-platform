import type { VisitActivity, VisitMetWith, VisitPurpose, VisitResult } from "@/lib/sales-visits/types";

export const VISIT_PURPOSE_LABELS: Record<VisitPurpose, string> = {
  OFFER_PRODUCT: "Penawaran produk",
  CHECK_STOCK: "Cek stok/kebutuhan",
  COLLECTION: "Penagihan",
  HANDLE_COMPLAINT: "Menangani komplain",
  FOLLOW_UP: "Follow-up",
  RELATIONSHIP: "Menjaga hubungan pelanggan",
  OTHER: "Lainnya",
};

export const VISIT_RESULT_LABELS: Record<VisitResult, string> = {
  MET_STORE: "Bertemu pihak toko",
  STORE_CLOSED: "Toko tutup",
  PERSON_NOT_AVAILABLE: "Pihak toko tidak berada di tempat",
  ADDRESS_NOT_FOUND: "Alamat tidak ditemukan",
  VISIT_CANCELLED: "Kunjungan dibatalkan",
  OTHER: "Lainnya",
};

export const VISIT_MET_WITH_LABELS: Record<VisitMetWith, string> = {
  OWNER: "Pemilik",
  PURCHASING: "Bagian pembelian",
  CASHIER: "Kasir",
  EMPLOYEE: "Karyawan",
  OTHER: "Lainnya",
};

export const VISIT_ACTIVITY_LABELS: Record<VisitActivity, string> = {
  OFFER_PRODUCT: "Menawarkan produk",
  CHECK_STOCK: "Mengecek stok dan kebutuhan",
  EXPLAIN_PROMO: "Menjelaskan program/promosi",
  COLLECT_PAYMENT: "Menagih pembayaran",
  HANDLE_COMPLAINT: "Menangani komplain",
  MARKET_INFO: "Mengambil informasi pasar",
  AGREE_FOLLOW_UP: "Menyepakati tindak lanjut",
};
