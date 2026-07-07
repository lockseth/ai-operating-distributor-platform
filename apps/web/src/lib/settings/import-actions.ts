"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";

export type EntityType = "customer" | "product" | "sales_order";
export type TransformType = "none" | "uppercase" | "lowercase" | "phone_id" | "date_iso" | "number";

export interface ColumnMapping {
  source_column:  string;
  target_field:   string;
  target_type:    "core" | "custom";
  is_required:    boolean;
  default_value:  string | null;
  transform:      TransformType;
}

export interface ImportTemplateFormData {
  name:            string;
  entity_type:     EntityType;
  description:     string | null;
  column_mappings: ColumnMapping[];
  file_has_header: boolean;
  delimiter:       string;
  sheet_name:      string | null;
}

// -----------------------------------------------------------------------
// Create Import Template
// -----------------------------------------------------------------------
export async function createImportTemplateAction(
  data: ImportTemplateFormData
): Promise<void> {
  const user = await getAuthUser();
  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) throw new Error("Tidak punya akses untuk membuat import template");

  const supabase = await createClient();
  const { data: tmpl, error } = await supabase
    .from("import_templates")
    .insert({
      company_id:      user.company_id,
      name:            data.name.trim(),
      entity_type:     data.entity_type,
      description:     data.description?.trim() || null,
      column_mappings: data.column_mappings,
      file_has_header: data.file_has_header,
      delimiter:       data.delimiter,
      sheet_name:      data.sheet_name?.trim() || null,
      is_active:       true,
      created_by:      user.id,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "import_template.create",
    entity_type: "import_templates",
    entity_id:   tmpl.id,
    new_data:    { name: data.name, entity_type: data.entity_type },
  }).catch(() => {});

  revalidatePath("/dashboard/settings/import");
  redirect(`/dashboard/settings/import/${tmpl.id}`);
}

// -----------------------------------------------------------------------
// Update Import Template
// -----------------------------------------------------------------------
export async function updateImportTemplateAction(
  templateId: string,
  data: ImportTemplateFormData
): Promise<void> {
  const user = await getAuthUser();
  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) throw new Error("Tidak punya akses");

  const supabase = await createClient();
  const { error } = await supabase
    .from("import_templates")
    .update({
      name:            data.name.trim(),
      entity_type:     data.entity_type,
      description:     data.description?.trim() || null,
      column_mappings: data.column_mappings,
      file_has_header: data.file_has_header,
      delimiter:       data.delimiter,
      sheet_name:      data.sheet_name?.trim() || null,
    })
    .eq("id", templateId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(error.message);

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "import_template.update",
    entity_type: "import_templates",
    entity_id:   templateId,
    new_data:    { name: data.name },
  }).catch(() => {});

  revalidatePath("/dashboard/settings/import");
  revalidatePath(`/dashboard/settings/import/${templateId}`);
  redirect(`/dashboard/settings/import/${templateId}`);
}

// -----------------------------------------------------------------------
// Delete / Deactivate Import Template
// -----------------------------------------------------------------------
export async function deactivateImportTemplateAction(templateId: string): Promise<void> {
  const user = await getAuthUser();

  const supabase = await createClient();
  await supabase
    .from("import_templates")
    .update({ is_active: false })
    .eq("id", templateId)
    .eq("company_id", user.company_id);

  revalidatePath("/dashboard/settings/import");
}
