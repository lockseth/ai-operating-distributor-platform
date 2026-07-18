"use server";

// =============================================================================
// Server actions — Tambah Toko & PIC (dashboard admin). Tenant & actor
// SELALU dari sesi (getAuthUser()), tidak pernah dari input form -- pola
// sama seperti lib/order-disputes/actions.ts.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { SupabaseCustomerPicRepository } from "./repository";
import type { AdminSettablePicStatus, PicRole } from "./types";

export interface CustomerPicActionResult {
  ok: boolean;
  error?: string;
  customerId?: string;
  customerPicId?: string;
}

/** Tambah Toko dari dashboard admin -- reuse RPC yang sama dengan Telegram, source berbeda. */
export async function createStoreAction(input: {
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;
  storeArea: string | null;
  assignedSalesId: string | null;
  picName: string;
  picPhone: string;
  picEmail?: string | null;
  picRoles: PicRole[];
  overrideSimilarDuplicate?: boolean;
  overrideReason?: string | null;
}): Promise<CustomerPicActionResult & { duplicateCustomerId?: string; outcome?: string }> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.create")) {
    return { ok: false, error: "Tidak berwenang menambah toko." };
  }
  if (!input.storeName.trim() || !input.picName.trim() || !input.picPhone.trim()) {
    return { ok: false, error: "Nama toko, nama PIC, dan nomor PIC wajib diisi." };
  }

  const supabase = getAdminClient();
  const repository = new SupabaseCustomerPicRepository(supabase);

  const result = await repository.createStoreWithPic({
    companyId: user.company_id,
    actorId: user.id,
    storeName: input.storeName,
    storePhone: input.storePhone,
    storeAddress: input.storeAddress,
    storeArea: input.storeArea,
    storeLatitude: null,
    storeLongitude: null,
    assignedSalesId: input.assignedSalesId,
    picName: input.picName,
    picPhone: input.picPhone,
    picEmail: input.picEmail ?? null,
    picRoles: input.picRoles,
    idempotencyKey: `admin:${user.id}:${Date.now()}`,
    source: "ADMIN_DASHBOARD",
    overrideSimilarDuplicate: input.overrideSimilarDuplicate ?? false,
    overrideReason: input.overrideReason ?? null,
  });

  if (result.outcome === "created" || result.outcome === "already_exists") {
    revalidatePath("/dashboard/customers");
    revalidatePath(`/dashboard/customers/${result.customerId}`);
    return { ok: true, customerId: result.customerId, customerPicId: result.customerPicId, outcome: result.outcome };
  }
  if (result.outcome === "exact_duplicate_store" || result.outcome === "similar_duplicate_warning") {
    return { ok: false, error: "Toko serupa sudah terdaftar.", duplicateCustomerId: result.duplicateCustomerId, outcome: result.outcome };
  }
  if (result.outcome === "area_not_assigned") return { ok: false, error: "Wilayah tidak ditugaskan ke Salesman ini." };
  if (result.outcome === "invalid_area") return { ok: false, error: "Wilayah tidak valid untuk tenant ini." };
  if (result.outcome === "invalid_assigned_sales") return { ok: false, error: "Salesman yang dipilih tidak valid." };
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "invalid_input") return { ok: false, error: "Data tidak lengkap/valid." };
  return { ok: false, error: result.outcome === "unexpected_error" ? result.error : "Gagal membuat toko." };
}

/** Tambah PIC ke toko yang sudah ada. */
export async function createCustomerPicAction(input: {
  customerId: string;
  name: string;
  phone: string;
  email?: string | null;
  roles: PicRole[];
}): Promise<CustomerPicActionResult & { existingCustomerPicId?: string }> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.create") && !hasPermission(user.permissions, "customers.update")) {
    return { ok: false, error: "Tidak berwenang menambah PIC." };
  }
  if (!input.name.trim() || !input.phone.trim()) return { ok: false, error: "Nama dan nomor PIC wajib diisi." };

  const supabase = getAdminClient();
  const repository = new SupabaseCustomerPicRepository(supabase);

  const result = await repository.createCustomerPic({
    companyId: user.company_id,
    customerId: input.customerId,
    actorId: user.id,
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    roles: input.roles,
    idempotencyKey: `admin:${user.id}:${Date.now()}`,
    source: "ADMIN_DASHBOARD",
  });

  if (result.outcome === "created" || result.outcome === "already_exists") {
    revalidatePath(`/dashboard/customers/${input.customerId}`);
    return { ok: true, customerPicId: result.customerPicId };
  }
  if (result.outcome === "phone_exists_on_store") {
    return { ok: false, error: "Nomor ini sudah terdaftar sebagai PIC pada toko ini.", existingCustomerPicId: result.existingCustomerPicId };
  }
  if (result.outcome === "customer_not_found") return { ok: false, error: "Toko tidak ditemukan." };
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "invalid_input") return { ok: false, error: "Data tidak lengkap/valid." };
  return { ok: false, error: result.outcome === "unexpected_error" ? result.error : "Gagal menambah PIC." };
}

/** Ubah nama/nomor/role/email PIC -- wajib alasan, audited, history. */
export async function updateCustomerPicAction(input: {
  customerId: string;
  customerPicId: string;
  newName?: string | null;
  newPhone?: string | null;
  newRoles?: PicRole[] | null;
  newEmail?: string | null;
  reason: string;
}): Promise<CustomerPicActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.pic_verify") && !hasPermission(user.permissions, "customers.update")) {
    return { ok: false, error: "Tidak berwenang mengubah data PIC." };
  }
  if (!input.reason.trim()) return { ok: false, error: "Alasan wajib diisi." };

  const supabase = getAdminClient();
  const repository = new SupabaseCustomerPicRepository(supabase);

  const result = await repository.updateCustomerPic({
    companyId: user.company_id,
    customerPicId: input.customerPicId,
    actorId: user.id,
    newName: input.newName ?? null,
    newPhone: input.newPhone ?? null,
    newRoles: input.newRoles ?? null,
    newEmail: input.newEmail ?? null,
    reason: input.reason,
    source: "ADMIN_DASHBOARD",
  });

  if (result.outcome === "updated" || result.outcome === "no_changes") {
    revalidatePath(`/dashboard/customers/${input.customerId}`);
    return { ok: true, customerPicId: input.customerPicId };
  }
  if (result.outcome === "not_found") return { ok: false, error: "PIC tidak ditemukan." };
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "invalid_input") return { ok: false, error: "Data tidak valid (periksa format email)." };
  return { ok: false, error: result.outcome === "unexpected_error" ? result.error : "Gagal mengubah data PIC." };
}

/** Manual verification -- HANYA owner/manager/admin/super_admin, tidak boleh reviewer = pembuat PIC. */
export async function verifyCustomerPicAction(input: {
  customerId: string;
  customerPicId: string;
  newStatus: AdminSettablePicStatus;
  reason: string;
}): Promise<CustomerPicActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.pic_verify")) {
    return { ok: false, error: "Tidak berwenang melakukan verifikasi PIC." };
  }
  if (!input.reason.trim()) return { ok: false, error: "Alasan wajib diisi." };

  const supabase = getAdminClient();
  const repository = new SupabaseCustomerPicRepository(supabase);

  const result = await repository.verifyCustomerPic({
    companyId: user.company_id,
    customerPicId: input.customerPicId,
    reviewerId: user.id,
    newStatus: input.newStatus,
    reason: input.reason,
  });

  if (result.outcome === "verified") {
    revalidatePath(`/dashboard/customers/${input.customerId}`);
    return { ok: true, customerPicId: input.customerPicId };
  }
  if (result.outcome === "not_found") return { ok: false, error: "PIC tidak ditemukan." };
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "invalid_input") return { ok: false, error: "Status tidak valid." };
  return { ok: false, error: result.outcome === "unexpected_error" ? result.error : "Gagal memverifikasi PIC." };
}
