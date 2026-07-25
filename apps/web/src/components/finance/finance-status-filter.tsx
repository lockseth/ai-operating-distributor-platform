"use client";

// Gate 2I.2 -- satu wrapper client generic di atas FilterBar existing (kontrak
// §10: "pola sama DataTable + FilterBar existing"), dipakai seluruh list
// domain finance (Invoice/Collection/Payment/Reconciliation) -- bukan filter
// per-domain. Navigasi lewat query string supaya deep-link/bookmark tetap
// mengembalikan state filter yang sama (kontrak §16).

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { FilterBar } from "@/components/ui/filter-bar";

interface FinanceStatusFilterProps {
  options: { label: string; value: string }[];
  paramKey?: string;
  label?: string;
}

export function FinanceStatusFilter({ options, paramKey = "status", label = "Status" }: FinanceStatusFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(paramKey) ?? "";

  function handleChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set(paramKey, next);
    else params.delete(paramKey);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  return <FilterBar options={options} value={value} onChange={handleChange} label={label} />;
}
