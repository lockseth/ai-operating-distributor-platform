"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import {
  ACTOR_TYPE_LABELS,
  EVENT_CATEGORY_LABELS,
  OUTCOME_LABELS,
  SOURCE_LABELS,
} from "@/lib/audit-log/format";

interface ActorOption { id: string; full_name: string; }

interface AuditLogFiltersProps {
  actors: ActorOption[];
  totalCount: number;
}

const FILTER_KEYS = [
  "q", "from", "to", "module", "actor", "category", "action", "entity", "source", "outcome",
] as const;

export function AuditLogFilters({ actors, totalCount }: AuditLogFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const values = Object.fromEntries(
    FILTER_KEYS.map((key) => [key, searchParams.get(key) ?? ""])
  ) as Record<(typeof FILTER_KEYS)[number], string>;

  const hasFilters = FILTER_KEYS.some((key) => values[key]);

  function update(key: string, value: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (value) sp.set(key, value); else sp.delete(key);
    sp.delete("page");
    router.replace(`/dashboard/owner/activity-log?${sp.toString()}`);
  }

  function reset() {
    router.replace("/dashboard/owner/activity-log");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Cari aksi, entitas, modul, alasan..."
            defaultValue={values.q}
            onChange={(e) => update("q", e.target.value)}
            className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        <input
          type="date"
          value={values.from}
          onChange={(e) => update("from", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 px-3 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="text-xs text-gray-400">s/d</span>
        <input
          type="date"
          value={values.to}
          onChange={(e) => update("to", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 px-3 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-gray-400">{totalCount.toLocaleString("id-ID")} aktivitas</span>
          {hasFilters && (
            <button
              onClick={reset}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            >
              <X className="h-3 w-3" /> Reset
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Modul"
          defaultValue={values.module}
          onChange={(e) => update("module", e.target.value)}
          className="w-32 rounded-lg border border-gray-200 py-2 px-3 text-sm text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <select
          value={values.actor}
          onChange={(e) => update("actor", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Pelaku</option>
          <option value="__ai_system__">AI / Sistem</option>
          {actors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
        </select>

        <select
          value={values.category}
          onChange={(e) => update("category", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Kategori</option>
          {Object.entries(EVENT_CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Jenis aksi"
          defaultValue={values.action}
          onChange={(e) => update("action", e.target.value)}
          className="w-32 rounded-lg border border-gray-200 py-2 px-3 text-sm text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <input
          type="text"
          placeholder="Entitas"
          defaultValue={values.entity}
          onChange={(e) => update("entity", e.target.value)}
          className="w-28 rounded-lg border border-gray-200 py-2 px-3 text-sm text-gray-700 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <select
          value={values.source}
          onChange={(e) => update("source", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Sumber</option>
          {Object.entries(SOURCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <select
          value={values.outcome}
          onChange={(e) => update("outcome", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Status</option>
          {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function actorTypeLabel(actorType: string | null): string {
  if (!actorType) return "—";
  return ACTOR_TYPE_LABELS[actorType] ?? actorType;
}
