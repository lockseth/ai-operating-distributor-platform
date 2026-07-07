import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { updateImportTemplateAction } from "@/lib/settings/import-actions";
import { ImportTemplateForm } from "@/components/settings/import-template-form";
import { ChevronLeft } from "lucide-react";
import type { ImportTemplateFormData, ColumnMapping, EntityType } from "@/lib/settings/import-actions";

export const metadata = { title: "Edit Template Import — AODP" };

export default async function EditImportTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  const hasAccess = user.roles.includes("super_admin") || user.roles.includes("owner") ||
    user.roles.includes("manager") || user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");
  if (!hasAccess) redirect("/dashboard/settings/import");

  const supabase = await createClient();
  const { data } = await supabase
    .from("import_templates")
    .select("id, name, entity_type, description, column_mappings, file_has_header, delimiter, sheet_name")
    .eq("id", id)
    .eq("company_id", user.company_id)
    .single();

  if (!data) notFound();

  const t = data as unknown as {
    id: string; name: string; entity_type: string; description: string | null;
    column_mappings: ColumnMapping[]; file_has_header: boolean;
    delimiter: string; sheet_name: string | null;
  };

  const initialData: ImportTemplateFormData = {
    name:            t.name,
    entity_type:     t.entity_type as EntityType,
    description:     t.description,
    column_mappings: Array.isArray(t.column_mappings) ? t.column_mappings : [],
    file_has_header: t.file_has_header,
    delimiter:       t.delimiter,
    sheet_name:      t.sheet_name,
  };

  const boundAction = updateImportTemplateAction.bind(null, id);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href={`/dashboard/settings/import/${id}`} className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Template
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Edit Template Import</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mengedit: <span className="font-medium text-gray-700">{t.name}</span>
        </p>
      </div>

      <ImportTemplateForm
        initialData={initialData}
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/settings/import/${id}`}
      />
    </div>
  );
}
