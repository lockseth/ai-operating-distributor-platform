"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

interface SalesUser { id: string; full_name: string; }

interface CustomerFiltersProps {
  cities: string[];
  areas: string[];
  salesUsers: SalesUser[];
  totalCount: number;
}

export function CustomerFilters({ cities, areas, salesUsers, totalCount }: CustomerFiltersProps) {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const q      = searchParams.get("q") ?? "";
  const city   = searchParams.get("city") ?? "";
  const area   = searchParams.get("area") ?? "";
  const sales  = searchParams.get("sales") ?? "";
  const status = searchParams.get("status") ?? "active";

  const hasFilters = q || city || area || sales || status !== "active";

  function update(key: string, value: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (value) sp.set(key, value); else sp.delete(key);
    sp.delete("page");
    router.replace(`/dashboard/customers?${sp.toString()}`);
  }

  function reset() {
    router.replace("/dashboard/customers");
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Search */}
      <div className="relative flex-1 min-w-48">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
        <input
          type="text"
          placeholder="Cari nama, telepon, kota, area..."
          defaultValue={q}
          onChange={(e) => {
            const v = e.target.value;
            const sp = new URLSearchParams(searchParams.toString());
            if (v) sp.set("q", v); else sp.delete("q");
            sp.delete("page");
            router.replace(`/dashboard/customers?${sp.toString()}`);
          }}
          className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* Status filter */}
      <select
        value={status}
        onChange={(e) => update("status", e.target.value)}
        className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="active">Aktif</option>
        <option value="inactive">Nonaktif</option>
        <option value="all">Semua Status</option>
      </select>

      {/* City filter */}
      {cities.length > 0 && (
        <select
          value={city}
          onChange={(e) => update("city", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Kota</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}

      {/* Area filter */}
      {areas.length > 0 && (
        <select
          value={area}
          onChange={(e) => update("area", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Area</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      )}

      {/* Sales filter */}
      {salesUsers.length > 0 && (
        <select
          value={sales}
          onChange={(e) => update("sales", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Sales</option>
          {salesUsers.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
        </select>
      )}

      {/* Count + Reset */}
      <div className="flex items-center gap-2 ml-auto">
        <span className="text-xs text-gray-400">{totalCount.toLocaleString("id-ID")} pelanggan</span>
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
  );
}
