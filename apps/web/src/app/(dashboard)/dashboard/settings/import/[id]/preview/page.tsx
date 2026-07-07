import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { getImportTemplateAction } from "@/lib/settings/import-preview-actions";
import { ImportPreviewClient } from "@/components/settings/import-preview-client";
import { ChevronLeft, FileSpreadsheet } from "lucide-react";

export const metadata = { title: "Preview Import — AODP" };

export default async function ImportPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) redirect("/dashboard");

  const { data: template, error } = await getImportTemplateAction(id);

  if (error || !template) redirect("/dashboard/settings/import");

  if (!template.is_active) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-medium text-amber-800">
            Template import ini sudah dinonaktifkan dan tidak dapat digunakan untuk preview.
          </p>
          <Link href="/dashboard/settings/import"
            className="mt-3 inline-block text-sm text-amber-600 hover:underline">
            ← Kembali ke daftar template
          </Link>
        </div>
      </div>
    );
  }

  if (template.column_mappings.length === 0) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-medium text-amber-800">
            Template ini belum memiliki mapping kolom. Tambahkan mapping terlebih dahulu sebelum preview.
          </p>
          <Link href={`/dashboard/settings/import/${id}/edit`}
            className="mt-3 inline-block text-sm text-amber-600 hover:underline">
            Edit Template →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between">
        <Link href={`/dashboard/settings/import/${id}`}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Template
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-green-50 shrink-0">
          <FileSpreadsheet className="h-6 w-6 text-green-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Preview Import Data</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Upload file CSV, sistem akan mem-parsing dan memvalidasi data sebelum import dilakukan.
            <span className="ml-1 font-medium text-amber-600">Data belum disimpan ke sistem.</span>
          </p>
        </div>
      </div>

      {/* Mapping summary */}
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wide">
          Konfigurasi Mapping ({template.column_mappings.length} kolom)
        </p>
        <div className="flex flex-wrap gap-2">
          {template.column_mappings.map((m) => (
            <div key={m.target_field}
              className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-gray-50 px-2.5 py-1.5 text-xs">
              <span className="text-gray-500">{m.source_column}</span>
              <span className="text-gray-300">→</span>
              <code className="font-mono text-blue-700">{m.target_field}</code>
              {m.is_required && <span className="text-red-400 font-bold">*</span>}
              {m.transform !== "none" && (
                <span className="text-purple-500 text-[10px]">({m.transform})</span>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-gray-400">
          <span className="text-red-400 font-bold">*</span> = wajib diisi
        </p>
      </div>

      <ImportPreviewClient template={template} />
    </div>
  );
}
