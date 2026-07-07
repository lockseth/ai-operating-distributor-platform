import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { ChevronLeft, Edit2, ArrowRight, FileSpreadsheet, CheckCircle2, Circle, PlayCircle } from "lucide-react";
import type { ColumnMapping } from "@/lib/settings/import-actions";

export const metadata = { title: "Detail Template Import — AODP" };

const ENTITY_LABEL: Record<string, string> = {
  customer: "Pelanggan", product: "Produk", sales_order: "Sales Order",
};
const TRANSFORM_LABEL: Record<string, string> = {
  none: "—", uppercase: "UPPERCASE", lowercase: "lowercase",
  phone_id: "Telepon ID", date_iso: "Tanggal ISO", number: "Angka",
};

interface Template {
  id: string; name: string; entity_type: string; description: string | null;
  column_mappings: ColumnMapping[]; file_has_header: boolean;
  delimiter: string; sheet_name: string | null; is_active: boolean; created_at: string;
  creator: { full_name: string } | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

export default async function ImportTemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  const hasAccess = user.roles.includes("super_admin") || user.roles.includes("owner") ||
    user.roles.includes("manager") || user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");
  if (!hasAccess) redirect("/dashboard");

  const supabase = await createClient();
  const { data } = await supabase
    .from("import_templates")
    .select("*, creator:users!created_by(full_name)")
    .eq("id", id)
    .eq("company_id", user.company_id)
    .single();

  if (!data) notFound();

  const template = data as unknown as Template;
  const mappings = Array.isArray(template.column_mappings) ? template.column_mappings : [];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Breadcrumb + Actions */}
      <div className="flex items-center justify-between">
        <Link href="/dashboard/settings/import"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Import Template
        </Link>
        <div className="flex items-center gap-2">
          <Link href={`/dashboard/settings/import/${id}/preview`}
            className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700">
            <PlayCircle className="h-4 w-4" />
            Preview Import
          </Link>
          <Link href={`/dashboard/settings/import/${id}/edit`}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <Edit2 className="h-4 w-4" />
            Edit
          </Link>
        </div>
      </div>

      {/* Header */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 shrink-0">
            <FileSpreadsheet className="h-6 w-6 text-blue-600" />
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-xl font-bold text-gray-900">{template.name}</h1>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${template.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                {template.is_active ? "Aktif" : "Nonaktif"}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm text-gray-500">
              <span>Tipe: <strong>{ENTITY_LABEL[template.entity_type] ?? template.entity_type}</strong></span>
              <span>·</span>
              <span>{mappings.length} kolom dimapping</span>
              <span>·</span>
              <span>{template.file_has_header ? "Ada header" : "Tanpa header"}</span>
            </div>
            {template.description && (
              <p className="mt-2 text-sm text-gray-500">{template.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* File Config */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Delimiter", value: template.delimiter === "\t" ? "Tab" : template.delimiter },
          { label: "Nama Sheet", value: template.sheet_name ?? "Sheet pertama" },
          { label: "Baris Header", value: template.file_has_header ? "Ada" : "Tidak ada" },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border bg-white p-4 shadow-sm">
            <p className="text-xs text-gray-500 mb-1">{item.label}</p>
            <p className="text-sm font-semibold text-gray-900">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Mapping Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
          <ArrowRight className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-900">Mapping Kolom</h2>
        </div>

        {mappings.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-400">Belum ada mapping kolom dikonfigurasi.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-500">Kolom di File</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-400">→</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Field Sistem</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Transform</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Default</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Wajib</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {mappings.map((m, idx) => (
                <tr key={idx} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-900">{m.source_column}</td>
                  <td className="px-4 py-3 text-center text-gray-300">→</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-blue-700 bg-blue-50 rounded px-1.5 py-0.5">
                      {m.target_field}
                    </span>
                    {m.target_type === "custom" && (
                      <span className="ml-1 text-xs text-purple-600">(custom)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {TRANSFORM_LABEL[m.transform] ?? m.transform}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{m.default_value ?? "—"}</td>
                  <td className="px-4 py-3 text-center">
                    {m.is_required
                      ? <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                      : <Circle className="h-4 w-4 text-gray-200 mx-auto" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Metadata */}
      <div className="rounded-xl border bg-gray-50 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>Dibuat: {formatDate(template.created_at)}</span>
          {template.creator?.full_name && <span>oleh {template.creator.full_name}</span>}
          <span className="font-mono">ID: {template.id}</span>
        </div>
      </div>
    </div>
  );
}
