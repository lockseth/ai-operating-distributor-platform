"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { logAuditEvent } from "@/lib/actions/audit";

function adminClient() {
  return getAdminClient();
}

export type SubscriptionPlan   = "trial" | "starter" | "professional" | "enterprise";
export type SubscriptionStatus = "active" | "inactive" | "suspended" | "cancelled";

export interface CompanyFormData {
  name: string;
  slug: string;
  domain: string | null;
  subscription_plan: SubscriptionPlan;
  settings: {
    brand_color: string;
    timezone: string;
    currency: string;
    language: string;
  };
}

export interface FirstUserFormData {
  full_name: string;
  email: string;
  phone: string | null;
  temp_password: string;
}

// -----------------------------------------------------------------------
// Create Company (Tenant)
// -----------------------------------------------------------------------
export async function createCompanyAction(data: CompanyFormData): Promise<void> {
  const me = await getAuthUser();
  if (!me.roles.includes("super_admin")) throw new Error("Akses ditolak");

  const supabase = adminClient();

  const { data: company, error } = await supabase
    .from("companies")
    .insert({
      name:                data.name.trim(),
      slug:                data.slug.trim().toLowerCase(),
      domain:              data.domain?.trim() || null,
      subscription_plan:   data.subscription_plan,
      subscription_status: "active",
      is_active:           true,
      settings:            data.settings,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("Slug sudah digunakan, gunakan yang lain");
    throw new Error(error.message);
  }

  await logAuditEvent({
    company_id:  me.company_id,
    user_id:     me.id,
    action:      "tenant.create",
    entity_type: "companies",
    entity_id:   company.id,
    new_data:    { name: data.name, slug: data.slug, plan: data.subscription_plan },
    module:      "platform",
  }).catch(() => {});

  revalidatePath("/dashboard/platform/tenants");
  redirect(`/dashboard/platform/tenants/${company.id}`);
}

// -----------------------------------------------------------------------
// Update Company
// -----------------------------------------------------------------------
export async function updateCompanyAction(
  companyId: string,
  data: CompanyFormData
): Promise<void> {
  const me = await getAuthUser();
  if (!me.roles.includes("super_admin")) throw new Error("Akses ditolak");

  const supabase = adminClient();
  const { error } = await supabase
    .from("companies")
    .update({
      name:     data.name.trim(),
      slug:     data.slug.trim().toLowerCase(),
      domain:   data.domain?.trim() || null,
      settings: data.settings,
      subscription_plan: data.subscription_plan,
    })
    .eq("id", companyId);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  me.company_id,
    user_id:     me.id,
    action:      "tenant.update",
    entity_type: "companies",
    entity_id:   companyId,
    new_data:    { name: data.name, plan: data.subscription_plan },
    module:      "platform",
  }).catch(() => {});

  revalidatePath("/dashboard/platform/tenants");
  revalidatePath(`/dashboard/platform/tenants/${companyId}`);
  redirect(`/dashboard/platform/tenants/${companyId}`);
}

// -----------------------------------------------------------------------
// Create First Owner User
// -----------------------------------------------------------------------
export async function createFirstUserAction(
  companyId: string,
  data: FirstUserFormData
): Promise<{ error?: string }> {
  const me = await getAuthUser();
  if (!me.roles.includes("super_admin")) return { error: "Akses ditolak" };

  const supabase = adminClient();

  // 1. Create Supabase Auth user
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email:             data.email,
    password:          data.temp_password,
    email_confirm:     true,
    user_metadata:     { full_name: data.full_name },
  });

  if (authError) {
    if (authError.message.includes("already registered")) {
      return { error: "Email sudah terdaftar di sistem" };
    }
    return { error: authError.message };
  }

  // 2. Insert into public.users
  const { error: userError } = await supabase
    .from("users")
    .insert({
      id:         authUser.user.id,
      company_id: companyId,
      email:      data.email,
      full_name:  data.full_name,
      phone:      data.phone || null,
      is_active:  true,
    });

  if (userError) {
    // Rollback auth user
    await supabase.auth.admin.deleteUser(authUser.user.id).catch(() => {});
    return { error: userError.message };
  }

  // 3. Assign 'owner' role
  const { data: ownerRole } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "owner")
    .is("company_id", null)
    .single();

  if (ownerRole) {
    await supabase.from("user_roles").insert({
      user_id:     authUser.user.id,
      role_id:     ownerRole.id,
      company_id:  companyId,
      assigned_by: me.id,
    });
  }

  await logAuditEvent({
    company_id:  me.company_id,
    user_id:     me.id,
    action:      "tenant.first_user_created",
    entity_type: "users",
    entity_id:   authUser.user.id,
    new_data:    { email: data.email, company_id: companyId },
    module:      "platform",
  }).catch(() => {});

  revalidatePath(`/dashboard/platform/tenants/${companyId}`);
  return {};
}

// -----------------------------------------------------------------------
// Toggle company active status
// -----------------------------------------------------------------------
export async function toggleCompanyStatusAction(
  companyId: string,
  isActive: boolean
): Promise<void> {
  const me = await getAuthUser();
  if (!me.roles.includes("super_admin")) throw new Error("Akses ditolak");

  const supabase = adminClient();
  await supabase
    .from("companies")
    .update({ is_active: isActive, subscription_status: isActive ? "active" : "suspended" })
    .eq("id", companyId);

  await logAuditEvent({
    company_id:  me.company_id,
    user_id:     me.id,
    action:      isActive ? "tenant.activate" : "tenant.suspend",
    entity_type: "companies",
    entity_id:   companyId,
    module:      "platform",
  }).catch(() => {});

  revalidatePath("/dashboard/platform/tenants");
  revalidatePath(`/dashboard/platform/tenants/${companyId}`);
}
