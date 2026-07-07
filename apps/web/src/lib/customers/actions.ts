"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";

export interface CustomerFormData {
  name: string;
  code: string;
  type: "reseller" | "direct" | "distributor" | "modern_trade";
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  area: string | null;
  assigned_sales_id: string | null;
  notes: string | null;
  is_active: boolean;
  custom_fields: Record<string, string>;
}

export async function createCustomerAction(data: CustomerFormData): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.create")) {
    throw new Error("Tidak punya akses untuk membuat pelanggan");
  }

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("customers")
    .insert({
      company_id:        user.company_id,
      code:              data.code,
      name:              data.name,
      type:              data.type,
      phone:             data.phone || null,
      email:             data.email || null,
      address:           data.address || null,
      city:              data.city || null,
      area:              data.area || null,
      assigned_sales_id: data.assigned_sales_id || null,
      notes:             data.notes || null,
      is_active:         true,
      custom_fields:     data.custom_fields ?? {},
      created_by:        user.id,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "customer.create",
    entity_type: "customers",
    entity_id:   inserted.id,
    new_data:    { name: data.name, code: data.code, type: data.type },
  }).catch(() => {});

  revalidatePath("/dashboard/customers");
  redirect(`/dashboard/customers/${inserted.id}`);
}

export async function updateCustomerAction(
  customerId: string,
  oldData: Partial<CustomerFormData>,
  data: CustomerFormData
): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "customers.edit")) {
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
      area:              data.area || null,
      assigned_sales_id: data.assigned_sales_id || null,
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
    new_data:    { name: data.name, code: data.code, is_active: data.is_active },
  }).catch(() => {});

  revalidatePath("/dashboard/customers");
  revalidatePath(`/dashboard/customers/${customerId}`);
  redirect(`/dashboard/customers/${customerId}`);
}

export async function deactivateCustomerAction(customerId: string): Promise<void> {
  const user = await getAuthUser();
  const canDeactivate =
    hasPermission(user.permissions, "customers.delete") ||
    hasPermission(user.permissions, "customers.edit");
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
  if (!hasPermission(user.permissions, "customers.edit")) {
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
