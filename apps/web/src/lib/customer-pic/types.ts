// =============================================================================
// Tambah Toko & PIC — kontrak tipe.
//
// Toko TIDAK punya tabel baru -- public.customers dipakai langsung (lihat
// migration 20260728000001_customer_pic_master.sql). PIC (contact person)
// adalah entity baru: satu toko dapat memiliki beberapa PIC.
//
// Non-biometric (keputusan Pak Waluyo): tidak ada field KTP/foto wajah/face
// embedding/liveness di mana pun pada modul ini.
// =============================================================================

export type PicRole = "OWNER" | "ORDERER" | "RECEIVER" | "PAYMENT_CONTACT" | "BACKUP_CONTACT";

export const PIC_ROLES: readonly PicRole[] = ["OWNER", "ORDERER", "RECEIVER", "PAYMENT_CONTACT", "BACKUP_CONTACT"];

export const PIC_ROLE_LABEL: Record<PicRole, string> = {
  OWNER: "Pemilik",
  ORDERER: "Pemesan",
  RECEIVER: "Penerima Barang",
  PAYMENT_CONTACT: "Kontak Pembayaran",
  BACKUP_CONTACT: "Kontak Cadangan",
};

/**
 * VERIFIED_BY_ORDER dan VERIFIED_ON_DELIVERY HANYA boleh diklaim oleh
 * integrasi order/delivery masa depan setelah transaksi nyata terjadi --
 * gate ini TIDAK PERNAH men-set kedua nilai tsb (RPC verify_customer_pic
 * menolaknya di level DB juga).
 */
export type PicValidationStatus =
  | "UNVERIFIED"
  | "VERIFIED_BY_ADMIN"
  | "VERIFIED_BY_ORDER"
  | "VERIFIED_ON_DELIVERY"
  | "REVERIFY_REQUIRED"
  | "INACTIVE";

export const PIC_VALIDATION_STATUS_LABEL: Record<PicValidationStatus, string> = {
  UNVERIFIED: "Belum Diverifikasi",
  VERIFIED_BY_ADMIN: "Terverifikasi Admin",
  VERIFIED_BY_ORDER: "Terverifikasi via Order",
  VERIFIED_ON_DELIVERY: "Terverifikasi saat Pengiriman",
  REVERIFY_REQUIRED: "Perlu Verifikasi Ulang",
  INACTIVE: "Non-aktif",
};

/** Status yang boleh diset lewat verify_customer_pic() (manual admin) -- bukan seluruh PicValidationStatus. */
export type AdminSettablePicStatus = "VERIFIED_BY_ADMIN" | "REVERIFY_REQUIRED" | "INACTIVE";
export const ADMIN_SETTABLE_PIC_STATUSES: readonly AdminSettablePicStatus[] = [
  "VERIFIED_BY_ADMIN",
  "REVERIFY_REQUIRED",
  "INACTIVE",
];

export type PicHistoryChangeType =
  | "CREATED"
  | "NAME_CHANGED"
  | "PHONE_CHANGED"
  | "ROLES_CHANGED"
  | "STATUS_CHANGED"
  | "EMAIL_CHANGED";

export type PicChangeSource = "TELEGRAM_SALESMAN" | "ADMIN_DASHBOARD" | "ORDER_VERIFICATION" | "DELIVERY_VERIFICATION";

export type RelationshipEventType =
  | "PIC_ADDED"
  | "PIC_NAME_CHANGED"
  | "PIC_PHONE_CHANGED"
  | "PIC_ROLES_CHANGED"
  | "PIC_EMAIL_CHANGED"
  | "PIC_VERIFIED"
  | "PIC_REVERIFY_REQUIRED"
  | "PIC_DEACTIVATED"
  | "DUPLICATE_STORE_DETECTED"
  | "DUPLICATE_PIC_DETECTED";

export interface CustomerPicRecord {
  id: string;
  companyId: string;
  customerId: string;
  name: string;
  phone: string;
  /** Opsional -- tidak pernah jadi bukti verifikasi, tidak wajib unique. */
  email: string | null;
  roles: PicRole[];
  validationStatus: PicValidationStatus;
  createdBy: string;
  createdAt: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface CustomerPicHistoryRecord {
  id: string;
  companyId: string;
  customerPicId: string;
  customerId: string;
  changeType: PicHistoryChangeType;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  source: PicChangeSource;
  actorId: string;
  createdAt: string;
}

export interface CustomerRelationshipEventRecord {
  id: string;
  companyId: string;
  customerId: string;
  customerPicId: string | null;
  eventType: RelationshipEventType;
  severity: "info" | "low" | "medium" | "high";
  payload: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
}

export interface StoreSummary {
  id: string;
  companyId: string;
  name: string;
  phone: string | null;
  address: string | null;
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  assignedSalesId: string | null;
  isActive: boolean;
}

// -----------------------------------------------------------------------
// create_store_with_pic
// -----------------------------------------------------------------------

export interface CreateStoreWithPicInput {
  companyId: string;
  actorId: string;
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;
  storeArea: string | null;
  storeLatitude: number | null;
  storeLongitude: number | null;
  assignedSalesId: string | null;
  picName: string;
  picPhone: string;
  /** Opsional. Kosong/null selalu valid -- validasi format hanya jika diisi. */
  picEmail: string | null;
  picRoles: PicRole[];
  idempotencyKey: string | null;
  source: PicChangeSource;
  overrideSimilarDuplicate: boolean;
  overrideReason: string | null;
}

export type CreateStoreWithPicResult =
  | { outcome: "created" | "already_exists"; customerId: string; customerPicId: string }
  | { outcome: "exact_duplicate_store"; duplicateCustomerId: string }
  | { outcome: "similar_duplicate_warning"; duplicateCustomerId: string }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "invalid_area" }
  | { outcome: "area_not_assigned" }
  | { outcome: "invalid_assigned_sales" }
  | { outcome: "unexpected_error"; error: string };

// -----------------------------------------------------------------------
// create_customer_pic
// -----------------------------------------------------------------------

export interface CreateCustomerPicInput {
  companyId: string;
  customerId: string;
  actorId: string;
  name: string;
  phone: string;
  /** Opsional. Kosong/null selalu valid -- validasi format hanya jika diisi. */
  email: string | null;
  roles: PicRole[];
  idempotencyKey: string | null;
  source: PicChangeSource;
}

/**
 * "phone_exists_on_store": nomor PIC yang diajukan sudah terdaftar pada PIC
 * LAIN di toko yang SAMA -- RPC mengembalikan record existing (existingCustomerPicId)
 * alih-alih membuat duplicate baru secara diam-diam.
 */
export type CreateCustomerPicResult =
  | { outcome: "created" | "already_exists"; customerPicId: string }
  | { outcome: "phone_exists_on_store"; existingCustomerPicId: string }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "customer_not_found" }
  | { outcome: "unexpected_error"; error: string };

// -----------------------------------------------------------------------
// update_customer_pic
// -----------------------------------------------------------------------

export interface UpdateCustomerPicInput {
  companyId: string;
  customerPicId: string;
  actorId: string;
  newName: string | null;
  newPhone: string | null;
  newRoles: PicRole[] | null;
  /** null = tidak diubah (sama seperti newName/newPhone/newRoles). Email TIDAK mempengaruhi validation_status. */
  newEmail: string | null;
  reason: string;
  source: PicChangeSource;
}

export type UpdateCustomerPicResult =
  | { outcome: "updated" | "no_changes" }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "not_found" }
  | { outcome: "unexpected_error"; error: string };

// -----------------------------------------------------------------------
// verify_customer_pic
// -----------------------------------------------------------------------

export interface VerifyCustomerPicInput {
  companyId: string;
  customerPicId: string;
  reviewerId: string;
  newStatus: AdminSettablePicStatus;
  reason: string;
}

/**
 * Tidak ada outcome "self_verify_forbidden" -- larangan self-verify HANYA
 * berlaku untuk actor Salesman, dan itu sudah ditegakkan penuh oleh role
 * gate (Salesman tidak pernah punya role owner/manager/admin/super_admin).
 * Admin/owner/manager BOLEH memverifikasi PIC yang mereka buat sendiri
 * (tenant kecil bisa jadi hanya punya satu admin/owner).
 */
export type VerifyCustomerPicResult =
  | { outcome: "verified"; newStatus: AdminSettablePicStatus }
  | { outcome: "invalid_input" }
  | { outcome: "forbidden" }
  | { outcome: "not_found" }
  | { outcome: "unexpected_error"; error: string };
