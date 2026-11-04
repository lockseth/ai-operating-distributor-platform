"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignCustomerClassAction } from "@/lib/customers/class-actions";

interface ClassOption { id: string; name: string; defaultPaymentTermsDays: number | null }

export function CustomerClassPicker({ customerId, currentClassId, options }: { customerId: string; currentClassId: string | null; options: ClassOption[] }) {
  const router = useRouter();
  const [value, setValue] = useState(currentClassId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function save(next: string) {
    setValue(next);
    setError(null);
    startTransition(async () => {
      const res = await assignCustomerClassAction(customerId, next || null);
      if (!res.ok) { setError(res.error ?? "Gagal menyimpan."); setValue(currentClassId ?? ""); return; }
      router.refresh();
    });
  }

  return (
    <div className="text-sm">
      <select value={value} disabled={isPending} onChange={(e) => save(e.target.value)} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2">
        <option value="">Belum diklasifikasikan</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}{o.defaultPaymentTermsDays ? ` — tempo ${o.defaultPaymentTermsDays} hari` : " — tunai"}</option>
        ))}
      </select>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
