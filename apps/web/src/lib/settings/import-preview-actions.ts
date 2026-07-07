"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";
import type { ColumnMapping } from "./import-actions";

export interface ImportTemplate {
  id: string;
  name: string;
  entity_type: string;
  description: string | null;
  column_mappings: ColumnMapping[];
  file_has_header: boolean;
  delimiter: string;
  sheet_name: string | null;
  is_active: boolean;
}

export async function getImportTemplateAction(
  templateId: string
): Promise<{ data?: ImportTemplate; error?: string }> {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) return { error: "Akses ditolak" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("import_templates")
    .select("id, name, entity_type, description, column_mappings, file_has_header, delimiter, sheet_name, is_active")
    .eq("id", templateId)
    .eq("company_id", user.company_id)
    .single();

  if (error || !data) return { error: "Template tidak ditemukan" };

  return { data: data as unknown as ImportTemplate };
}

export async function logImportPreviewAction(
  templateId: string,
  templateName: string,
  stats: { total: number; valid: number; errors: number }
): Promise<void> {
  const user = await getAuthUser();
  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "import.preview",
    entity_type: "import_templates",
    entity_id:   templateId,
    new_data: {
      template_name: templateName,
      total_rows:    stats.total,
      valid_rows:    stats.valid,
      error_rows:    stats.errors,
    },
  }).catch(() => {});
}
