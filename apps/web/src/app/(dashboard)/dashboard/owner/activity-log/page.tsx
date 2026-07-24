import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { History } from "lucide-react";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { AuditLogFilters, actorTypeLabel } from "@/components/audit-log/audit-log-filters";
import {
  EVENT_CATEGORY_LABELS,
  OUTCOME_LABELS,
  SOURCE_LABELS,
  formatJakartaDateTime,
  redactSensitive,
  summarizeChange,
} from "@/lib/audit-log/format";

export const metadata = { title: "Activity & Audit Log — AODP" };

const PAGE_SIZE = 20;

interface AuditLogRow {
  id: string;
  user_id: string | null;
  actor_type: string | null;
  event_category: string | null;
  module: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_data: unknown;
  new_data: unknown;
  source: string | null;
  outcome: string | null;
  reason: string | null;
  created_at: string;
  users: { full_name: string; email: string } | null;
}

interface ActorOption { id: string; full_name: string; }

interface SearchParams {
  q?: string; from?: string; to?: string; module?: string; actor?: string;
  category?: string; action?: string; entity?: string; source?: string;
  outcome?: string; page?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase PostgrestFilterBuilder generic ketat, dipakai untuk 2 tipe select berbeda (data query & head-count query)
function applyAuditLogFilters(query: any, params: SearchParams) {
  const q = params.q ?? "";
  const from = params.from ?? "";
  const to = params.to ?? "";
  const moduleFilter = params.module ?? "";
  const actor = params.actor ?? "";
  const category = params.category ?? "";
  const actionFilter = params.action ?? "";
  const entity = params.entity ?? "";
  const source = params.source ?? "";
  const outcome = params.outcome ?? "";

  if (q) query = query.or(`action.ilike.%${q}%,entity_type.ilike.%${q}%,module.ilike.%${q}%,reason.ilike.%${q}%`);
  if (from) query = query.gte("created_at", `${from}T00:00:00+07:00`);
  if (to) query = query.lte("created_at", `${to}T23:59:59+07:00`);
  if (moduleFilter) query = query.ilike("module", `%${moduleFilter}%`);
  if (actionFilter) query = query.ilike("action", `%${actionFilter}%`);
  if (entity) query = query.ilike("entity_type", `%${entity}%`);
  if (category) query = query.eq("event_category", category);
  if (source) query = query.eq("source", source);
  if (outcome) query = query.eq("outcome", outcome);
  if (actor === "__ai_system__") query = query.or("actor_type.in.(ai,system),user_id.is.null");
  else if (actor) query = query.eq("user_id", actor);

  return query;
}

function hasActiveFilters(params: SearchParams): boolean {
  return Boolean(
    params.q || params.from || params.to || params.module || params.actor ||
    params.category || params.action || params.entity || params.source || params.outcome
  );
}

function actorLabel(row: AuditLogRow): string {
  if (row.users?.full_name) return row.users.full_name;
  if (row.actor_type) return actorTypeLabel(row.actor_type);
  if (row.user_id) return "Pengguna tidak diketahui";
  return "Sistem/AI";
}

function outcomeBadgeClass(outcome: string | null): string {
  switch (outcome) {
    case "success": return "bg-green-100 text-green-700";
    case "rejected": return "bg-amber-100 text-amber-700";
    case "failed": return "bg-red-100 text-red-700";
    case "unchanged": return "bg-gray-100 text-gray-500";
    default: return "bg-gray-100 text-gray-400";
  }
}

async function AuditLogTable({ companyId, params }: { companyId: string; params: SearchParams }) {
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  const baseQuery = supabase
    .from("audit_logs")
    .select(
      "id, user_id, actor_type, event_category, module, action, entity_type, entity_id, old_data, new_data, source, outcome, reason, created_at, users(full_name, email)",
      { count: "exact" }
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const { data, count } = await applyAuditLogFilters(baseQuery, params);

  const rows = (data ?? []) as unknown as AuditLogRow[];
  const totalCount = count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasFilters = hasActiveFilters(params);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-10 w-10 text-gray-300" />}
        title="Tidak ada aktivitas ditemukan"
        description={hasFilters
          ? "Coba ubah atau reset filter pencarian."
          : "Belum ada aktivitas tercatat pada tenant ini, atau event lama belum memiliki kategori/modul (retrofit dijadwalkan pada Gate 1D-B/1D-C)."}
      />
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Waktu</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Pelaku</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Kategori</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Modul</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Aksi</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Entitas</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Sumber</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row) => {
              const changeLines = summarizeChange(row.old_data, row.new_data);
              const safeReason = row.reason ? redactSensitive({ reason: row.reason }) as { reason: string } : null;
              return (
                <tr key={row.id} className="align-top hover:bg-gray-50">
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {formatJakartaDateTime(row.created_at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700">
                    <div className="font-medium">{actorLabel(row)}</div>
                    {row.actor_type && row.users?.full_name && (
                      <div className="text-gray-400">{actorTypeLabel(row.actor_type)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {row.event_category ? EVENT_CATEGORY_LABELS[row.event_category] ?? row.event_category : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{row.module ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-700">{row.action}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {row.entity_type}
                    {row.entity_id && <div className="text-gray-300 font-mono">{row.entity_id.slice(0, 8)}…</div>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {row.source ? SOURCE_LABELS[row.source] ?? row.source : "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeBadgeClass(row.outcome)}`}>
                      {row.outcome ? OUTCOME_LABELS[row.outcome] ?? row.outcome : "—"}
                    </span>
                    {(changeLines.length > 0 || safeReason) && (
                      <details className="mt-1 text-left">
                        <summary className="cursor-pointer text-xs text-blue-600 hover:text-blue-800 list-none text-center">Detail</summary>
                        <div className="mt-1 rounded-lg bg-gray-50 p-2 text-xs text-gray-600 space-y-0.5">
                          {changeLines.map((line, i) => <div key={i}>{line}</div>)}
                          {safeReason && <div className="italic text-gray-500">Alasan: {safeReason.reason}</div>}
                        </div>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
          <p className="text-sm text-gray-500">
            Menampilkan {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} dari {totalCount.toLocaleString("id-ID")} aktivitas
          </p>
          <div className="flex gap-1">
            {page > 1 && <PaginationLink page={page - 1} params={params} label="← Sebelumnya" />}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
              return <PaginationLink key={p} page={p} params={params} label={String(p)} isActive={p === page} />;
            })}
            {page < totalPages && <PaginationLink page={page + 1} params={params} label="Berikutnya →" />}
          </div>
        </div>
      )}
    </div>
  );
}

function PaginationLink({ page, params, label, isActive }: {
  page: number; params: SearchParams; label: string; isActive?: boolean;
}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key !== "page" && value) sp.set(key, value);
  }
  sp.set("page", String(page));
  return (
    <Link
      href={`/dashboard/owner/activity-log?${sp.toString()}`}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors ${
        isActive ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function ActivityAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getAuthUser();

  // Owner-only -- tidak menyandarkan pada sidebar visibility. Demo session
  // tidak punya baris users/company nyata untuk di-scan, jadi tidak
  // ditampilkan (persis pola /dashboard/owner/coverage-areas).
  if (user.isDemo || !user.roles.includes("owner")) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  const summaryQuery = supabase
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", user.company_id);

  const [{ data: actorRows }, { count: summaryCount }] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .order("full_name"),
    applyAuditLogFilters(summaryQuery, params),
  ]);

  const actors = (actorRows ?? []) as unknown as ActorOption[];

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Activity & Audit Log"
        subtitle="Riwayat aktivitas dan audit trail tenant ini. Append-only -- tidak ada edit/hapus. Gate 1D-A: fondasi kontrak event; retrofit seluruh menu berjalan bertahap (Gate 1D-B/1D-C)."
      />

      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <p className="text-xs text-gray-400 mb-3">
          Total {(summaryCount ?? 0).toLocaleString("id-ID")} aktivitas sesuai periode/filter yang dipilih.
        </p>
        <AuditLogFilters actors={actors} totalCount={summaryCount ?? 0} />
      </div>

      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <Suspense fallback={<div className="p-8 flex justify-center"><LoadingSpinner /></div>}>
          <AuditLogTable companyId={user.company_id} params={params} />
        </Suspense>
      </div>
    </div>
  );
}
