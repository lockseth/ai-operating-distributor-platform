import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { SupabaseImportRepository } from "@/lib/imports/repository";
import { IMPORT_TYPE_LABEL, type ReconciliationSummary } from "@/lib/imports/types";
import { RollbackButton } from "@/components/imports/rollback-button";
import { CommitButton } from "@/components/imports/commit-button";
import { deriveImportStatusLabel, IMPORT_STATUS_TONE_CLASSES } from "@/lib/data-onboarding/core/status-label";

export const metadata = { title: "Detail Import — AODP" };

function formatDateTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

export default async function ImportBatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) redirect("/dashboard/imports");

  const repository = new SupabaseImportRepository(getAdminClient());
  const batch = await repository.getBatch(user.company_id, id);
  if (!batch) notFound();
  const rows = await repository.getBatchRows(user.company_id, id);

  const canCommit = hasPermission(user.permissions, "imports.commit");
  const canRollback = hasPermission(user.permissions, "imports.rollback");
  const reconciliation = batch.reconciliation as ReconciliationSummary | Record<string, never>;
  const hasReconciliation = "sourceTotal" in reconciliation;
  const errorRows = rows.filter((r) => r.validationStatus === "ERROR");
  const status = deriveImportStatusLabel({
    status: batch.status, errorRows: batch.errorRows, warningRows: batch.warningRows, reconciliation,
  });
  // Commit hanya boleh tersedia kalau data BENAR-BENAR siap (SIAP DI-COMMIT/SIAP DITINJAU --
  // warning tetap boleh commit, error/mismatch tidak pernah) ATAU retry setelah commit gagal (FAILED).
  const commitAllowed = batch.status === "FAILED" || status.label === "SIAP DI-COMMIT" || status.label === "SIAP DITINJAU";

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <Link href="/dashboard/imports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ChevronLeft className="h-4 w-4" /> Kembali ke Import
      </Link>

      <div className="rounded-xl border bg-white p-6 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{IMPORT_TYPE_LABEL[batch.importType]}</h1>
            <p className="text-xs text-gray-500">{batch.originalFilename} · Sumber: {batch.sourceSystem}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${IMPORT_STATUS_TONE_CLASSES[status.tone]}`}>{status.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 pt-2">
          <Stat label="Total" value={batch.totalRows} />
          <Stat label="Valid" value={batch.validRows} icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-500" />} />
          <Stat label="Warning" value={batch.warningRows} icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />} />
          <Stat label="Duplicate" value={batch.duplicateRows} />
          <Stat label="Error" value={batch.errorRows} icon={<XCircle className="h-3.5 w-3.5 text-red-500" />} />
        </div>

        {hasReconciliation && (
          <div className="rounded-lg bg-gray-50 p-3 text-xs space-y-1">
            <p className="font-medium text-gray-700">Reconciliation AR</p>
            <p>Total sumber: {formatCurrency(reconciliation.sourceTotal)}</p>
            <p>Total akan diimport: {formatCurrency(reconciliation.importTotal)}</p>
            <p>Total dikecualikan (duplicate/review): {formatCurrency(reconciliation.excludedTotal)}</p>
            <p className={reconciliation.withinTolerance ? "text-green-700" : "text-red-700"}>
              Selisih: {formatCurrency(reconciliation.difference)} ({reconciliation.withinTolerance ? "seimbang" : "TIDAK seimbang -- tidak bisa commit"})
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-x-6 gap-y-1 pt-2 text-xs text-gray-500">
          <span>Dibuat: {formatDateTime(batch.createdAt)}</span>
          <span>Divalidasi: {formatDateTime(batch.validatedAt)}</span>
          <span>Di-commit: {formatDateTime(batch.committedAt)}</span>
          {batch.rolledBackAt && <span>Di-rollback: {formatDateTime(batch.rolledBackAt)}</span>}
        </div>

        {batch.failureReason && (
          <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700">Gagal: {batch.failureReason}</p>
        )}

        <div className="flex items-center gap-2 pt-2">
          {commitAllowed && canCommit && (
            <CommitButton batchId={batch.id} isRetry={batch.status === "FAILED"} />
          )}
          {batch.status === "COMMITTED" && canRollback && <RollbackButton batchId={batch.id} />}
        </div>
      </div>

      {errorRows.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b px-5 py-3"><h2 className="text-sm font-semibold text-gray-900">Baris Error ({errorRows.length})</h2></div>
          <div className="max-h-96 overflow-y-auto divide-y divide-gray-50">
            {errorRows.map((r) => (
              <div key={r.id} className="px-5 py-2 text-xs">
                <span className="font-medium text-gray-700">Baris {r.rowNumber}:</span>{" "}
                {r.errors.map((e) => e.message).join("; ")}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-100 p-2.5">
      <div className="flex items-center gap-1 text-[11px] text-gray-500">{icon}{label}</div>
      <div className="text-base font-semibold text-gray-900">{value}</div>
    </div>
  );
}
