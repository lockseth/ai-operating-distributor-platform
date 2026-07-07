"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

interface SalesUser { id: string; full_name: string; }

interface OrderFiltersProps {
  salesUsers: SalesUser[];
  totalCount: number;
}

const STATUS_OPTIONS = [
  { value: "",           label: "Semua Status" },
  { value: "draft",      label: "Draft" },
  { value: "confirmed",  label: "Dikonfirmasi" },
  { value: "processing", label: "Diproses" },
  { value: "delivering", label: "Dikirim" },
  { value: "delivered",  label: "Terkirim" },
  { value: "invoiced",   label: "Ditagih" },
  { value: "paid",       label: "Lunas" },
  { value: "cancelled",  label: "Dibatalkan" },
];

export function OrderFilters({ salesUsers, totalCount }: OrderFiltersProps) {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const q          = searchParams.get("q") ?? "";
  const status     = searchParams.get("status") ?? "";
  const sales      = searchParams.get("sales") ?? "";
  const date_from  = searchParams.get("date_from") ?? "";
  const date_to    = searchParams.get("date_to") ?? "";

  const hasFilters = q || status || sales || date_from || date_to;

  function update(key: string, value: string) {
    const sp = new URLSearchParams(searchParams.toString());
    if (value) sp.set(key, value); else sp.delete(key);
    sp.delete("page");
    router.replace(`/dashboard/orders?${sp.toString()}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Cari no. order, nama / telepon pelanggan..."
            defaultValue={q}
            onChange={(e) => {
              const sp = new URLSearchParams(searchParams.toString());
              if (e.target.value) sp.set("q", e.target.value); else sp.delete("q");
              sp.delete("page");
              router.replace(`/dashboard/orders?${sp.toString()}`);
            }}
            className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>

        {/* Status */}
        <select value={status} onChange={(e) => update("status", e.target.value)}
          className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        {/* Sales */}
        {salesUsers.length > 0 && (
          <select value={sales} onChange={(e) => update("sales", e.target.value)}
            className="rounded-lg border border-gray-200 py-2 pl-3 pr-7 text-sm text-gray-700 focus:border-blue-500 focus:outline-none">
            <option value="">Semua Sales</option>
            {salesUsers.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-gray-400">{totalCount.toLocaleString("id-ID")} order</span>
          {hasFilters && (
            <button onClick={() => router.replace("/dashboard/orders")}
              className="flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-500 hover:bg-gray-50">
              <X className="h-3 w-3" /> Reset
            </button>
          )}
        </div>
      </div>

      {/* Date range */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">Rentang tanggal:</span>
        <input type="date" value={date_from} onChange={(e) => update("date_from", e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:border-blue-500 focus:outline-none" />
        <span className="text-xs text-gray-400">s/d</span>
        <input type="date" value={date_to} onChange={(e) => update("date_to", e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 focus:border-blue-500 focus:outline-none" />
      </div>
    </div>
  );
}
