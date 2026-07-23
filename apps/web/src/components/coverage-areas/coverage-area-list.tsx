"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, Pencil, Plus, Store, UserCheck, X } from "lucide-react";
import {
  createCoverageAreaAction,
  updateCoverageAreaAction,
  setCoverageAreaActiveStatusAction,
} from "@/lib/coverage-area/actions";

export interface CoverageAreaRow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  salesmanCount: number;
  storeCount: number;
}

const inputCls =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

export function CoverageAreaList({ areas }: { areas: CoverageAreaRow[] }) {
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  return (
    <div className="space-y-4">
      {feedback && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
            feedback.type === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {feedback.message}
        </div>
      )}

      <div className="rounded-xl border bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-900">
            {areas.length} wilayah terdaftar
          </h2>
          {!showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-3.5 w-3.5" />
              Tambah Wilayah
            </button>
          )}
        </div>

        {showAddForm && (
          <div className="border-b border-gray-100 px-5 py-4">
            <AddAreaForm
              onCancel={() => setShowAddForm(false)}
              onDone={(message, type) => {
                setShowAddForm(false);
                setFeedback({ type, message });
                router.refresh();
              }}
            />
          </div>
        )}

        {areas.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-gray-400">
            Belum ada wilayah. Tambahkan wilayah pertama untuk tenant ini.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Nama</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Keterangan</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Salesman</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Toko</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {areas.map((area) =>
                editingId === area.id ? (
                  <tr key={area.id}>
                    <td colSpan={6} className="px-4 py-3">
                      <EditAreaForm
                        area={area}
                        onCancel={() => setEditingId(null)}
                        onDone={(message, type) => {
                          setEditingId(null);
                          setFeedback({ type, message });
                          router.refresh();
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  <AreaRow
                    key={area.id}
                    area={area}
                    onEdit={() => setEditingId(area.id)}
                    onStatusChanged={(message, type) => {
                      setFeedback({ type, message });
                      router.refresh();
                    }}
                  />
                )
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function AreaRow({
  area,
  onEdit,
  onStatusChanged,
}: {
  area: CoverageAreaRow;
  onEdit: () => void;
  onStatusChanged: (message: string, type: "success" | "error") => void;
}) {
  const [isPending, startTransition] = useTransition();

  function toggleStatus() {
    startTransition(async () => {
      const result = await setCoverageAreaActiveStatusAction(area.id, !area.isActive);
      if (!result.ok) {
        onStatusChanged(result.error ?? "Gagal mengubah status wilayah.", "error");
        return;
      }
      onStatusChanged(
        result.active ? `Wilayah "${area.name}" diaktifkan.` : `Wilayah "${area.name}" dinonaktifkan.`,
        "success"
      );
    });
  }

  return (
    <tr className="hover:bg-gray-50">
      <td className="px-4 py-3 font-medium text-gray-900">{area.name}</td>
      <td className="px-4 py-3 text-gray-600">{area.description ?? <span className="text-gray-400">—</span>}</td>
      <td className="px-4 py-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            area.isActive ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"
          }`}
        >
          {area.isActive ? "Aktif" : "Nonaktif"}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-600">
        <span className="inline-flex items-center gap-1">
          <UserCheck className="h-3.5 w-3.5 text-gray-400" />
          {area.salesmanCount}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-600">
        <span className="inline-flex items-center gap-1">
          <Store className="h-3.5 w-3.5 text-gray-400" />
          {area.storeCount}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onEdit}
            disabled={isPending}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            type="button"
            onClick={toggleStatus}
            disabled={isPending}
            className={`inline-flex items-center gap-1 text-xs font-medium disabled:opacity-50 ${
              area.isActive ? "text-red-600 hover:text-red-700" : "text-green-600 hover:text-green-700"
            }`}
          >
            {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {area.isActive ? "Nonaktifkan" : "Aktifkan"}
          </button>
        </div>
      </td>
    </tr>
  );
}

function AddAreaForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (message: string, type: "success" | "error") => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Nama wilayah wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createCoverageAreaAction(trimmed, description);
      if (!result.ok) {
        setError(result.error ?? "Gagal menambahkan wilayah.");
        return;
      }
      onDone(`Wilayah "${trimmed}" berhasil ditambahkan.`, "success");
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            Nama Wilayah <span className="text-red-500">*</span>
          </label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Cirebon Timur" className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Keterangan</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opsional" className={inputCls} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Simpan Wilayah
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} className="text-xs font-medium text-gray-500 hover:text-gray-700">
          Batal
        </button>
      </div>
    </div>
  );
}

function EditAreaForm({
  area,
  onCancel,
  onDone,
}: {
  area: CoverageAreaRow;
  onCancel: () => void;
  onDone: (message: string, type: "success" | "error") => void;
}) {
  const [name, setName] = useState(area.name);
  const [description, setDescription] = useState(area.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Nama wilayah wajib diisi.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateCoverageAreaAction(area.id, trimmed, description);
      if (!result.ok) {
        setError(result.error ?? "Gagal mengedit wilayah.");
        return;
      }
      onDone(`Wilayah "${area.name}" berhasil diperbarui menjadi "${trimmed}".`, "success");
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Nama Wilayah</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Keterangan</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Simpan Perubahan
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isPending}
          className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          <X className="h-3 w-3" />
          Batal
        </button>
      </div>
    </div>
  );
}
