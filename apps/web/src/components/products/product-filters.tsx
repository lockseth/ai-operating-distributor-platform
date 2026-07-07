"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useTransition } from "react";
import { Search, X } from "lucide-react";

interface Category {
  id: string;
  name: string;
}

interface ProductFiltersProps {
  categories: Category[];
  totalCount: number;
}

const STATUS_OPTIONS = [
  { value: "all",      label: "Semua Status" },
  { value: "active",   label: "Aktif" },
  { value: "inactive", label: "Nonaktif" },
];

export function ProductFilters({ categories, totalCount }: ProductFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const q        = searchParams.get("q") ?? "";
  const category = searchParams.get("category") ?? "";
  const status   = searchParams.get("status") ?? "active";

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete("page");  // Reset to page 1 on filter change
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams]
  );

  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      const params = new URLSearchParams(searchParams.toString());
      if (val) { params.set("q", val); } else { params.delete("q"); }
      params.delete("page");
      // Debounce via replaceState to avoid URL flicker on every keystroke
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  const clearSearch = () => updateParam("q", "");
  const hasFilters = q || category || status !== "active";

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-48 max-w-72">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Cari nama produk atau SKU…"
            defaultValue={q}
            onChange={handleSearch}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {q && (
            <button
              onClick={clearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Category filter */}
        <select
          value={category}
          onChange={(e) => updateParam("category", e.target.value)}
          className="rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="">Semua Kategori</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        {/* Status filter */}
        <select
          value={status}
          onChange={(e) => updateParam("status", e.target.value)}
          className="rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        {/* Clear filters */}
        {hasFilters && (
          <button
            onClick={() => {
              startTransition(() => { router.push(pathname); });
            }}
            className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700"
          >
            <X className="h-3 w-3" /> Reset
          </button>
        )}
      </div>

      <p className="shrink-0 text-sm text-gray-500">
        {totalCount.toLocaleString("id-ID")} produk ditemukan
      </p>
    </div>
  );
}
