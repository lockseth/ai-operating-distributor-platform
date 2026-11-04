"use server";

// Kelola klasifikasi customer (K-1). Hanya Owner/Manager/Admin. Penulisan lewat
// admin client (RLS customer_classes sengaja tanpa policy tulis); company_id dan
// aktor SELALU dari sesi. Rancangan: docs/product/customer-classification/.

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { logAuditEvent } from "@/lib/actions/audit";
import { CLASS_MANAGER_ROLES, validateClassInput } from "./classification";

export interface ClassActionResult {
  ok: boolean;
  error?: string;
}

const FORBIDDEN: ClassActionResult = { ok: false, error: "Hanya Owner/Admin yang dapat mengelola klasifikasi customer." };

export async function saveCustomerClassAction(input: {
  id: string | null;
  name: string;
  defaultPaymentTermsDays: string;
  approvalThresholdAmount: string;
  isActive: boolean;
}): Promise<ClassActionResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, CLASS_MANAGER_ROLES)) return FORBIDDEN;

  const v = validateClassInput(input);
  if (!v.ok) return { ok: false, error: v.error };

  const admin = getAdminClient();
  const row = {
    name: v.value.name,
    default_payment_terms_days: v.value.defaultPaymentTermsDays,
    approval_threshold_amount: v.value.approvalThresholdAmount,
    is_active: input.isActive,
  };
  const { error } = input.id
    ? await admin.from("customer_classes").update(row).eq("id", input.id).eq("company_id", user.company_id)
    : await admin.from("customer_classes").insert({ ...row, company_id: user.company_id, created_by: user.id });
  if (error) {
    return { ok: false, error: error.code === "23505" ? "Nama klasifikasi sudah dipakai." : "Gagal menyimpan klasifikasi." };
  }

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id,
    action: input.id ? "customer_class.update" : "customer_class.create",
    entity_type: "customer_classes", entity_id: input.id ?? undefined,
    new_data: row, module: "customers",
  }).catch(() => {});

  revalidatePath("/dashboard/customers/classes");
  return { ok: true };
}

export async function assignCustomerClassAction(customerId: string, classId: string | null): Promise<ClassActionResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, CLASS_MANAGER_ROLES)) return FORBIDDEN;

  const admin = getAdminClient();
  if (classId) {
    const { data: cls } = await admin
      .from("customer_classes").select("id").eq("id", classId).eq("company_id", user.company_id).eq("is_active", true).maybeSingle();
    if (!cls) return { ok: false, error: "Klasifikasi tidak ditemukan." };
  }
  const { data: before } = await admin
    .from("customers").select("class_id").eq("id", customerId).eq("company_id", user.company_id).maybeSingle();
  if (!before) return { ok: false, error: "Customer tidak ditemukan." };

  const { error } = await admin.from("customers").update({ class_id: classId }).eq("id", customerId).eq("company_id", user.company_id);
  if (error) return { ok: false, error: "Gagal menetapkan klasifikasi." };

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id, action: "customer.class_assign",
    entity_type: "customers", entity_id: customerId,
    old_data: { class_id: (before as { class_id: string | null }).class_id }, new_data: { class_id: classId }, module: "customers",
  }).catch(() => {});

  revalidatePath(`/dashboard/customers/${customerId}`);
  revalidatePath("/dashboard/customers");
  return { ok: true };
}
