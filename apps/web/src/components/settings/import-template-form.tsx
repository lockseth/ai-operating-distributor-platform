"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { ImportMappingEditor } from "./import-mapping-editor";
import type { ImportTemplateFormData, ColumnMapping, EntityType } from "@/lib/settings/import-actions";

interface ImportTemplateFormProps {
  initialData?: Partial<ImportTemplateFormData>;
  action: (data: ImportTemplateFormData) => Promise<void>;
  submitLabel?: string;
  cancelHref?: string;
}

const ENTITY_OPTIONS: { value: EntityType; label: string; desc: string }[] = [
  { value: "customer",    label: "Pelanggan / Reseller", desc: "Data toko, kontak, area" },
  { value: "product",     label: "Produk",               desc: "Katalog produk, harga, stok" },
  { value: "sales_order", label: "Sales Order",          desc: "Histori order & transaksi" },
];

export function ImportTemplateForm({
  initialData, action, submitLabel = "Simpan", cancelHref,
}: ImportTemplateFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);

  const [name,        setName]        = useState(initialData?.name ?? "");
  const [entityType,  setEntityType]  = useState<EntityType>(initialData?.entity_type ?? "customer");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [fileHeader,  setFileHeader]  = useState(initialData?.file_has_header ?? true);
  const [delimiter,   setDelimiter]   = useState(initialData?.delimiter ?? ",");
  const [sheetName,   setSheetName]   = useState(initialData?.sheet_name ?? "");
  const [mappings,    setMappings]    = useState<ColumnMapping[]>(initialData?.column_mappings ?? []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Nama template wajib diisi"); return; }
    if (mappings.length === 0) { setError("Tambahkan minimal 1 mapping kolom"); return; }
    if (mappings.some((m) => !m.source_column.trim())) {
      setError("Isi semua nama kolom sumber (kolom di file)");
      return;
    }

    const data: ImportTemplateFormData = {
      name: name.trim(), entity_type: entityType,
      description: description.trim() || null,
      column_mappings: mappings,
      file_has_header: fileHeader,
      delimiter, sheet_name: sheetName.trim() || null,
    };

    startTransition(async () => {
      try { await action(data); }
      catch (err) { setError(err instanceof Error ? err.message : "Terjadi kesalahan"); }
    });
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-gray-700 mb-1";
  const section  = "rounded-xl border bg-white p-5 shadow-sm space-y-4";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Info Dasar */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Informasi Template</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Nama Template <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Import Pelanggan Awal" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Tipe Data <span className="text-red-500">*</span></label>
            <div className="grid grid-cols-1 gap-2">
              {ENTITY_OPTIONS.map((o) => (
                <label key={o.value}
                  className={`flex items-center gap-3 rounded-lg border-2 p-3 cursor-pointer ${
                    entityType === o.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                  }`}>
                  <input type="radio" name="entityType" value={o.value}
                    checked={entityType === o.value}
                    onChange={() => { setEntityType(o.value); setMappings([]); }}
                    className="sr-only" />
                  <div>
                    <p className={`text-sm font-medium ${entityType === o.value ? "text-blue-700" : "text-gray-800"}`}>{o.label}</p>
                    <p className="text-xs text-gray-400">{o.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Deskripsi</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Deskripsi singkat untuk memudahkan identifikasi template ini..."
                rows={3} className={`${inputCls} resize-none`} />
            </div>
            <div>
              <label className={labelCls}>Delimiter (CSV)</label>
              <select value={delimiter} onChange={(e) => setDelimiter(e.target.value)} className={inputCls}>
                <option value=",">Koma (,)</option>
                <option value=";">Titik koma (;)</option>
                <option value="\t">Tab</option>
                <option value="|">Pipe (|)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Nama Sheet (Excel)</label>
              <input type="text" value={sheetName} onChange={(e) => setSheetName(e.target.value)}
                placeholder="Sheet1 (kosong = sheet pertama)" className={inputCls} />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={fileHeader}
                onChange={(e) => setFileHeader(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span className="text-sm text-gray-700">File memiliki baris header (nama kolom)</span>
            </label>
          </div>
        </div>
      </div>

      {/* Mapping Editor */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Konfigurasi Mapping Kolom</h2>
        <ImportMappingEditor
          entityType={entityType}
          value={mappings}
          onChange={setMappings}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {cancelHref && (
          <a href={cancelHref}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Batal
          </a>
        )}
        <button type="submit" disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Menyimpan..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
