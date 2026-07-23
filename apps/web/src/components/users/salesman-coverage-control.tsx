"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin, Pencil } from "lucide-react";
import { updateSalesmanCoverageAreasAction } from "@/lib/salesman/actions";

export interface CoverageAreaWithStatus {
  id: string;
  name: string;
  isActive: boolean;
}

export function SalesmanCoverageControl({
  salesmanId,
  allAreas,
  assignedAreaIds,
}: {
  salesmanId: string;
  allAreas: CoverageAreaWithStatus[];
  assignedAreaIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>(assignedAreaIds);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(allAreas.map((a) => [a.id, a]));
  const assignedAreas = assignedAreaIds
    .map((id) => byId.get(id))
    .filter((a): a is CoverageAreaWithStatus => !!a);

  // Wilayah nonaktif tidak boleh dipilih untuk assignment BARU, tapi wilayah
  // yang sudah ter-assign sebelumnya tetap ditampilkan (histori tidak hilang)
  // supaya owner bisa melihat/melepaskannya.
  const selectableAreas = allAreas.filter((a) => a.isActive || assignedAreaIds.includes(a.id));

  function toggle(area: CoverageAreaWithStatus) {
    const isSelected = selected.includes(area.id);
    if (!area.isActive && !isSelected) return; // tidak bisa memilih wilayah nonaktif secara baru
    setSelected((prev) => (isSelected ? prev.filter((id) => id !== area.id) : [...prev, area.id]));
  }

  function save() {
    if (selected.length === 0) {
      setError("Pilih minimal satu wilayah.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateSalesmanCoverageAreasAction(salesmanId, selected);
      if (!result.ok) {
        setError(result.error ?? "Gagal memperbarui wilayah.");
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        {assignedAreas.length > 0 ? (
          <div className="flex flex-wrap gap-1 max-w-52">
            {assignedAreas.map((area) => (
              <span
                key={area.id}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  area.isActive ? "bg-indigo-50 text-indigo-700" : "bg-gray-100 text-gray-500"
                }`}
              >
                <MapPin className="h-3 w-3" />
                {area.name}
                {!area.isActive && <span className="text-[10px]">(nonaktif)</span>}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-gray-400">Belum ada wilayah</span>
        )}
        <button
          type="button"
          onClick={() => {
            setSelected(assignedAreaIds);
            setEditing(true);
          }}
          disabled={selectableAreas.length === 0}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Pencil className="h-3 w-3" />
          Ubah wilayah
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-64 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {selectableAreas.map((area) => {
          const active = selected.includes(area.id);
          return (
            <button
              key={area.id}
              type="button"
              onClick={() => toggle(area)}
              aria-pressed={active}
              disabled={!area.isActive && !active}
              className={`rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "border-blue-500 bg-blue-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {area.name}
              {!area.isActive && " (nonaktif)"}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Simpan
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={isPending}
          className="text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          Batal
        </button>
      </div>
    </div>
  );
}
