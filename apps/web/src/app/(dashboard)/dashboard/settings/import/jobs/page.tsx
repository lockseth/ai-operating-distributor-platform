import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { getImportJobsAction } from "@/lib/settings/import-execution";
import { LegacyImportDeprecationBanner } from "@/components/settings/legacy-import-deprecation-banner";
import { ChevronLeft, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";

export const metadata = { title: "Riwayat Import — AODP" };

const STATUS_CONFIG: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  completed: {
    label: "Selesai",
    cls:   "bg-green-100 text-green-700",
    icon:  <CheckCircle2 className="h-3 w-3" />,
  },
  failed: {
    label: "Gagal",
    cls:   "bg-red-100 text-red-600",
    icon:  <XCircle className="h-3 w-3" />,
  },
  processing: {
    label: "Diproses",
    cls:   "bg-blue-100 text-blue-700",
    icon:  <Clock className="h-3 w-3" />,
  },
  pending: {
    label: "Menunggu",
    cls:   "bg-gray-100 text-gray-600",
    icon:  <Clock className="h-3 w-3" />,
  },
};

const ENTITY_LABEL: Record<string, string> = {
  customer: "Pelanggan", product: "Produk", sales_order: "Sales Order",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default async function ImportJobsPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) redirect("/dashboard");

  const { data: jobs, error } = await getImportJobsAction();

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <LegacyImportDeprecationBanner />
      <div className="flex items-center justify-between">
        <Link href="/dashboard/settings/import"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Template Import
        </Link>
      </div>

      <div>
        <h1 className="text-xl font-bold text-gray-900">Riwayat Import Data</h1>
        <p className="text-sm text-gray-500 mt-1">50 import terakhir per tenant.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!jobs || jobs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 p-12 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">Belum ada riwayat import.</p>
          <Link href="/dashboard/settings/import"
            className="mt-3 inline-block text-sm text-blue-600 hover:underline">
            Mulai import data →
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-500">Waktu</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">File</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Tipe</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Template</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Total</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-green-600">Berhasil</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-amber-600">Lewati</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-red-500">Error</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {jobs.map((job) => {
                const st = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending;
                return (
                  <tr key={job.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {formatDateTime(job.created_at)}
                    </td>
                    <td className="px-4 py-3 max-w-[160px]">
                      <span className="block truncate text-xs font-medium text-gray-700" title={job.file_name}>
                        {job.file_name}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-gray-600">
                        {ENTITY_LABEL[job.entity_type] ?? job.entity_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {(job.template as { name: string } | null)?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-medium text-gray-700">
                      {job.total_rows}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-semibold text-green-600">
                      {job.success_rows}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-medium text-amber-600">
                      {job.skipped_rows}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-medium text-red-500">
                      {job.error_rows > 0 ? job.error_rows : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`flex items-center justify-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>
                        {st.icon}
                        {st.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
