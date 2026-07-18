import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseImportRepository } from "@/lib/imports/repository";
import { IMPORT_TYPE_LABEL } from "@/lib/imports/types";
import { Upload, Plus } from "lucide-react";
import { deriveImportStatusLabel, IMPORT_STATUS_TONE_CLASSES } from "@/lib/data-onboarding/core/status-label";

export const metadata = { title: "Import Data — AODP" };

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default async function ImportsListPage() {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) redirect("/dashboard");

  const repository = new SupabaseImportRepository(getAdminClient());
  const batches = await repository.listBatches(user.company_id);
  const canExecute = hasPermission(user.permissions, "imports.execute");

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-blue-600" />
          <h1 className="text-xl font-bold text-gray-900">Import Data</h1>
        </div>
        {canExecute && (
          <Link href="/dashboard/imports/new" className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" /> Import Baru
          </Link>
        )}
      </div>

      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        {batches.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-400">Belum ada import batch.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-2.5">Jenis</th>
                <th className="px-4 py-2.5">File</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Baris</th>
                <th className="px-4 py-2.5">Dibuat</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const status = deriveImportStatusLabel({
                  status: b.status, errorRows: b.errorRows, warningRows: b.warningRows, reconciliation: b.reconciliation,
                });
                return (
                  <tr key={b.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/imports/${b.id}`} className="font-medium text-blue-700 hover:underline">
                        {IMPORT_TYPE_LABEL[b.importType]}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{b.originalFilename}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${IMPORT_STATUS_TONE_CLASSES[status.tone]}`}>{status.label}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{b.validRows}/{b.totalRows} valid</td>
                    <td className="px-4 py-3 text-xs text-gray-400">{formatDateTime(b.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
