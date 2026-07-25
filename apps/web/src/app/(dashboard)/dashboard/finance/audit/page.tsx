// =============================================================================
// Gate 2I.4 -- Riwayat Audit Finance: Owner-only (kontrak §B.5/§H). Guard
// ganda: (1) finance/layout.tsx (receivable.view, existing); (2) di sini,
// page-level -- AlertCard "Hanya Owner..." (BUKAN redirect(), user sudah
// lolos guard layout, redirect ke /dashboard akan membingungkan). RLS
// audit_logs_select (20260819000001) sudah menegakkan Owner-only di DB --
// guard di sini adalah defense kedua + UX (non-owner tidak melihat form
// filter/tabel kosong yang membingungkan). module='finance' filter TETAP
// (kontrak §H), error query eksplisit -- BUKAN EmptyState yang menyamarkan
// kegagalan sebagai "belum ada aktivitas".
//
// Filter form GET server-rendered (bukan client component baru) -- subset
// kolom AuditLogFilters (kontrak §B.5 "reuse ATAU subset kolom") karena
// AuditLogFilters mengarahkan navigasi ke /dashboard/owner/activity-log
// (hardcoded), tidak cocok dipakai apa adanya di route ini tanpa modifikasi
// file itu (di luar allowed file plan gate ini).
// =============================================================================

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import {
  getFinanceAuditActorOptions,
  getFinanceAuditList,
  hasFinanceWorkspaceAccess,
  type FinanceAuditLogRow,
} from "@/lib/finance/queries";
import { PageHeader } from "@/components/ui/page-header";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { actorTypeLabel } from "@/components/audit-log/audit-log-filters";
import { formatJakartaDateTime, redactSensitive, summarizeChange } from "@/lib/audit-log/format";

export const metadata = { title: "Riwayat Audit Finance — AODP" };

interface SearchParams {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  entity?: string;
  entity_id?: string;
  page?: string;
}

function actorLabel(row: FinanceAuditLogRow): string {
  if (row.actorName) return row.actorName;
  if (row.actorType) return actorTypeLabel(row.actorType);
  if (row.userId) return "Pengguna tidak diketahui";
  return "Sistem/AI";
}

function outcomeBadgeClass(outcome: string | null): string {
  switch (outcome) {
    case "success":
      return "bg-green-100 text-green-700";
    case "rejected":
      return "bg-amber-100 text-amber-700";
    case "failed":
      return "bg-red-100 text-red-700";
    case "unchanged":
      return "bg-gray-100 text-gray-500";
    default:
      return "bg-gray-100 text-gray-400";
  }
}

const OUTCOME_LABELS: Record<string, string> = { success: "Berhasil", rejected: "Ditolak", unchanged: "Tidak berubah", failed: "Gagal" };

function buildHref(params: SearchParams, overrides: Partial<SearchParams>): string {
  const merged: SearchParams = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) sp.set(key, value);
  }
  const qs = sp.toString();
  return `/dashboard/finance/audit${qs ? `?${qs}` : ""}`;
}

function AuditRowDetail({ row }: { row: FinanceAuditLogRow }) {
  const changeLines = summarizeChange(row.oldData, row.newData);
  const safePayload = redactSensitive(row.newData ?? row.oldData);
  if (changeLines.length === 0 && !safePayload) return null;
  return (
    <details className="mt-1.5 text-left">
      <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800">Detail</summary>
      <div className="mt-1 space-y-0.5 rounded-lg bg-gray-50 p-2 text-xs text-gray-600">
        {changeLines.length > 0 ? changeLines.map((line, i) => <div key={i}>{line}</div>) : <div>Tidak ada ringkasan perubahan.</div>}
      </div>
    </details>
  );
}

export default async function FinanceAuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo || !user.roles.includes("owner")) {
    return (
      <AlertCard
        type="info"
        title="Hanya Owner yang dapat membuka Riwayat Audit"
        message="Kebijakan akses riwayat audit finance membatasi akses hanya untuk role Owner pada tenant ini."
      />
    );
  }

  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  let result: Awaited<ReturnType<typeof getFinanceAuditList>> | null = null;
  let actors: Awaited<ReturnType<typeof getFinanceAuditActorOptions>> = [];
  let loadError = false;
  try {
    [result, actors] = await Promise.all([
      getFinanceAuditList(user.company_id, {
        from: params.from,
        to: params.to,
        actor: params.actor,
        action: params.action,
        entity: params.entity,
        entityId: params.entity_id,
        page,
      }),
      getFinanceAuditActorOptions(user.company_id),
    ]);
  } catch {
    loadError = true;
  }

  const totalPages = result ? Math.ceil(result.totalCount / result.pageSize) : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Riwayat Audit Finance"
        subtitle="Aktivitas finance tenant ini (module=finance), Owner-only. Append-only -- tidak ada edit/hapus."
      />

      {params.entity_id && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700">
          Difilter untuk entitas <span className="font-mono">{params.entity}</span> ·{" "}
          <span className="font-mono">{params.entity_id.slice(0, 8)}…</span>{" "}
          <Link href="/dashboard/finance/audit" className="font-semibold underline">
            Hapus filter
          </Link>
        </div>
      )}

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <label className="text-xs font-medium text-gray-600">
          Dari
          <input type="date" name="from" defaultValue={params.from ?? ""} className="mt-1 block rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
        </label>
        <label className="text-xs font-medium text-gray-600">
          Sampai
          <input type="date" name="to" defaultValue={params.to ?? ""} className="mt-1 block rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
        </label>
        <label className="text-xs font-medium text-gray-600">
          Pelaku
          <select name="actor" defaultValue={params.actor ?? ""} className="mt-1 block rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs">
            <option value="">Semua Pelaku</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-600">
          Jenis Aksi
          <input type="text" name="action" defaultValue={params.action ?? ""} placeholder="mis. order_cancellation" className="mt-1 block w-40 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
        </label>
        <label className="text-xs font-medium text-gray-600">
          Entitas
          <input type="text" name="entity" defaultValue={params.entity ?? ""} placeholder="mis. order_cancellations" className="mt-1 block w-40 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
        </label>
        <button type="submit" className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700">
          Terapkan
        </button>
        <Link href="/dashboard/finance/audit" className="rounded-lg border border-gray-200 px-3.5 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
          Reset
        </Link>
      </form>

      {loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-semibold text-red-700">Gagal memuat riwayat audit</p>
          <p className="mt-1 text-xs text-red-500">Terjadi kendala saat mengambil data. Coba muat ulang halaman.</p>
        </div>
      ) : !result || result.items.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-gray-500">Tidak ada aktivitas ditemukan</p>
          <p className="mt-1 text-xs text-gray-400">Belum ada aktivitas finance tercatat sesuai periode/filter yang dipilih.</p>
        </div>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-gray-200 bg-white md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Waktu</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Pelaku</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Aksi</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Entitas</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {result.items.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{formatJakartaDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">{actorLabel(row)}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-700">{row.action}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {row.entityType}
                      {row.entityId && <div className="font-mono text-gray-300">{row.entityId.slice(0, 8)}…</div>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeBadgeClass(row.outcome)}`}>
                        {row.outcome ? OUTCOME_LABELS[row.outcome] ?? row.outcome : "—"}
                      </span>
                      <AuditRowDetail row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="space-y-2 md:hidden">
            {result.items.map((row) => (
              <li key={row.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{actorLabel(row)}</p>
                    <p className="mt-0.5 font-mono text-xs text-gray-600">{row.action}</p>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeBadgeClass(row.outcome)}`}>
                    {row.outcome ? OUTCOME_LABELS[row.outcome] ?? row.outcome : "—"}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div>
                    <dt className="text-gray-400">Waktu</dt>
                    <dd className="text-gray-700">{formatJakartaDateTime(row.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-400">Entitas</dt>
                    <dd className="text-gray-700">{row.entityType}</dd>
                  </div>
                </dl>
                <AuditRowDetail row={row} />
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-xs text-gray-500">
                Halaman {page} dari {totalPages} · {result.totalCount.toLocaleString("id-ID")} aktivitas
              </p>
              <div className="flex gap-1">
                {page > 1 && (
                  <Link href={buildHref(params, { page: String(page - 1) })} className="inline-flex h-8 items-center rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    ← Sebelumnya
                  </Link>
                )}
                {page < totalPages && (
                  <Link href={buildHref(params, { page: String(page + 1) })} className="inline-flex h-8 items-center rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
                    Berikutnya →
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
