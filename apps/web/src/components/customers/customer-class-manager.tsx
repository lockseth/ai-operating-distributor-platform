"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveCustomerClassAction } from "@/lib/customers/class-actions";

export interface ClassRow {
  id: string;
  name: string;
  defaultPaymentTermsDays: number | null;
  approvalThresholdAmount: number | null;
  isActive: boolean;
  customerCount: number;
}

const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm";

export function CustomerClassManager({ rows }: { rows: ClassRow[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [name, setName] = useState("");
  const [terms, setTerms] = useState("");
  const [threshold, setThreshold] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function open(row: ClassRow | null) {
    setEditingId(row ? row.id : "new");
    setName(row?.name ?? "");
    setTerms(row?.defaultPaymentTermsDays != null ? String(row.defaultPaymentTermsDays) : "");
    setThreshold(row?.approvalThresholdAmount != null ? String(row.approvalThresholdAmount) : "");
    setIsActive(row?.isActive ?? true);
    setError(null);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await saveCustomerClassAction({
        id: editingId === "new" ? null : editingId,
        name, defaultPaymentTermsDays: terms, approvalThresholdAmount: threshold, isActive,
      });
      if (!res.ok) { setError(res.error ?? "Gagal menyimpan."); return; }
      setEditingId(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-2">Klasifikasi</th>
              <th className="px-4 py-2">Tempo</th>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Belum ada klasifikasi. Tambahkan mis. Besar, Grosir, Eceran.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2 font-medium text-gray-900">{r.name}</td>
                <td className="px-4 py-2 text-gray-700">{r.defaultPaymentTermsDays ? `${r.defaultPaymentTermsDays} hari` : "Tunai"}</td>
                <td className="px-4 py-2 text-gray-700">{r.customerCount}</td>
                <td className="px-4 py-2">{r.isActive ? "Aktif" : "Nonaktif"}</td>
                <td className="px-4 py-2 text-right"><button type="button" onClick={() => open(r)} className="text-blue-600 underline">Ubah</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingId === null ? (
        <button type="button" onClick={() => open(null)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">Tambah Klasifikasi</button>
      ) : (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="block text-sm"><span className="mb-1 block font-medium text-gray-900">Nama</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="mis. Grosir" /></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-gray-900">Tempo bayar (hari)</span>
            <input type="number" min={1} value={terms} onChange={(e) => setTerms(e.target.value)} className={inputCls} placeholder="Kosongkan untuk tunai" /></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-gray-900">Ambang persetujuan Owner (Rp, opsional)</span>
            <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} className={inputCls} placeholder="Dipakai di tahap berikutnya" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Aktif</label>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={isPending} onClick={save} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{isPending ? "Menyimpan…" : "Simpan"}</button>
            <button type="button" onClick={() => setEditingId(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Batal</button>
          </div>
        </div>
      )}
    </div>
  );
}
