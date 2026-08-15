"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission, hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";

// Gate 3E-D3-A: sumber kebenaran attribution toko adalah actor tepercaya, bukan
// field client. Role di array ini mempertahankan workflow assignment existing
// (boleh menetapkan toko ke Sales mana pun); role di luar ini (mis. sales)
// SELALU diatribusikan ke dirinya sendiri, field assigned_sales_id dari client
// diabaikan sepenuhnya. Ditegakkan ulang di RLS customers_insert/customers_update
// (migration 20260919000001) sebagai enforcement utama -- ini mencegah error
// RLS pada alur normal Sales membuat/mengedit toko miliknya sendiri.
const ATTRIBUTION_BYPASS_ROLES = ["owner", "manager", "admin", "super_admin"];

function resolveAssignedSalesId(
  actorId: string,
  actorRoles: string[],
  clientValue: string | null
): string | null {
  if (hasRole(actorRoles, ATTRIBUTION_BYPASS_ROLES)) return clientValue || null;
  return actorId;
}

export interface CustomerFormData {
  name: string;
  code: string;
  type: "reseller" | "direct" | "distributor" | "modern_trade";
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  /** Wilayah Penjualan resmi (FK coverage_areas.id) — bukan customers.area (free text lama). */
  coverage_area_id: string | null;
  assigned_sales_id: string | null;
  notes: string | null;
  is_active: boolean;
  custom_fields: Record<string, string>;
}

// createCustomerAction (direct-insert, tanpa PIC/GPS/deteksi duplikat) --
// DIHAPUS 2026-08-15, digantikan AddStoreForm -> createStoreAction
// (create_store_with_pic RPC, lib/customer-pic/actions.ts) yang menyatukan
// jalur Web dengan jalur Telegram (deteksi duplikat toko, PIC wajib,
// GPS+foto opsional -- keputusan Pak Waluyo). updateCustomerAction di
// bawah TIDAK berubah (edit toko existing, di luar scope perubahan ini).

export async function updateCustomerAction(
  customerId: string,
  oldData: Partial<CustomerFormData>,
  data: CustomerFormData
): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.update")) {
    throw new Error("Tidak punya akses untuk mengedit pelanggan");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({
      name:              data.name,
      code:              data.code,
      type:              data.type,
      phone:             data.phone || null,
      email:             data.email || null,
      address:           data.address || null,
      city:              data.city || null,
      coverage_area_id:  data.coverage_area_id || null,
      assigned_sales_id: resolveAssignedSalesId(user.id, user.roles, data.assigned_sales_id),
      notes:             data.notes || null,
      is_active:         data.is_active,
      custom_fields:     data.custom_fields ?? {},
    })
    .eq("id", customerId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "customer.update",
    entity_type: "customers",
    entity_id:   customerId,
    old_data:    oldData as Record<string, unknown>,
    new_data:    { name: data.name, code: data.code, is_active: data.is_active, coverage_area_id: data.coverage_area_id },
  }).catch(() => {});

  revalidatePath("/dashboard/customers");
  revalidatePath(`/dashboard/customers/${customerId}`);
  redirect(`/dashboard/customers/${customerId}`);
}

export async function deactivateCustomerAction(customerId: string): Promise<void> {
  const user = await getAuthUser();
  const canDeactivate =
    hasPermission(user.permissions, "customers.delete") ||
    hasPermission(user.permissions, "customers.update");
  if (!canDeactivate) throw new Error("Tidak punya akses");

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ is_active: false })
    .eq("id", customerId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "customer.deactivate",
    entity_type: "customers",
    entity_id:   customerId,
  }).catch(() => {});

  revalidatePath("/dashboard/customers");
  revalidatePath(`/dashboard/customers/${customerId}`);
}

export async function activateCustomerAction(customerId: string): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.update")) {
    throw new Error("Tidak punya akses");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("customers")
    .update({ is_active: true })
    .eq("id", customerId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "customer.activate",
    entity_type: "customers",
    entity_id:   customerId,
  }).catch(() => {});

  revalidatePath("/dashboard/customers");
  revalidatePath(`/dashboard/customers/${customerId}`);
}
