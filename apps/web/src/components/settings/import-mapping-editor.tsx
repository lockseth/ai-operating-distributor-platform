"use client";

import { Plus, Trash2, ArrowRight } from "lucide-react";
import type { ColumnMapping, EntityType, TransformType } from "@/lib/settings/import-actions";

// -----------------------------------------------------------------------
// Core field definitions per entity type
// -----------------------------------------------------------------------
const CORE_FIELDS: Record<EntityType, { key: string; label: string; required?: boolean }[]> = {
  customer: [
    { key: "name",              label: "Nama Toko / Reseller", required: true },
    { key: "code",              label: "Kode Pelanggan",       required: true },
    { key: "type",              label: "Tipe" },
    { key: "phone",             label: "Telepon" },
    { key: "email",             label: "Email" },
    { key: "address",           label: "Alamat" },
    { key: "city",              label: "Kota" },
    { key: "area",              label: "Area / Wilayah" },
    { key: "notes",             label: "Catatan" },
    { key: "assigned_sales_id", label: "Kode Sales" },
  ],
  product: [
    { key: "name",           label: "Nama Produk",  required: true },
    { key: "sku",            label: "SKU / Kode",   required: true },
    { key: "unit",           label: "Satuan",        required: true },
    { key: "price",          label: "Harga Jual" },
    { key: "cost",           label: "HPP / Modal" },
    { key: "stock_quantity", label: "Stok Awal" },
    { key: "min_stock",      label: "Stok Minimum" },
    { key: "description",    label: "Deskripsi" },
    { key: "category_name",  label: "Nama Kategori" },
  ],
  sales_order: [
    { key: "order_number",    label: "No. Order",          required: true },
    { key: "customer_code",   label: "Kode Pelanggan",     required: true },
    { key: "product_sku",     label: "SKU Produk",         required: true },
    { key: "quantity",        label: "Jumlah",             required: true },
    { key: "unit_price",      label: "Harga Satuan" },
    { key: "discount_amount", label: "Diskon per Item" },
    { key: "delivery_date",   label: "Tanggal Kirim" },
    { key: "notes",           label: "Catatan" },
    { key: "sales_code",      label: "Kode Sales" },
  ],
};

const TRANSFORMS: { value: TransformType; label: string }[] = [
  { value: "none",      label: "Tidak ada" },
  { value: "uppercase", label: "HURUF KAPITAL" },
  { value: "lowercase", label: "huruf kecil" },
  { value: "phone_id",  label: "Format Telepon ID (+62)" },
  { value: "date_iso",  label: "Tanggal → ISO 8601" },
  { value: "number",    label: "Angka (hapus titik/koma)" },
];

interface ImportMappingEditorProps {
  entityType:      EntityType;
  value:           ColumnMapping[];
  onChange:        (mappings: ColumnMapping[]) => void;
}

function emptyRow(entityType: EntityType): ColumnMapping {
  const firstCore = CORE_FIELDS[entityType][0];
  return {
    source_column: "",
    target_field:  firstCore?.key ?? "",
    target_type:   "core",
    is_required:   false,
    default_value: null,
    transform:     "none",
  };
}

export function ImportMappingEditor({ entityType, value, onChange }: ImportMappingEditorProps) {
  const coreFields = CORE_FIELDS[entityType] ?? [];

  function updateRow(idx: number, patch: Partial<ColumnMapping>) {
    const next = value.map((row, i) => i === idx ? { ...row, ...patch } : row);
    onChange(next);
  }

  function addRow() {
    onChange([...value, emptyRow(entityType)]);
  }

  function removeRow(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  // Auto-fill: add suggested rows for required fields not yet mapped
  function autoFill() {
    const mappedTargets = new Set(value.map((r) => r.target_field));
    const toAdd = coreFields
      .filter((f) => f.required && !mappedTargets.has(f.key))
      .map((f): ColumnMapping => ({
        source_column: f.label,
        target_field:  f.key,
        target_type:   "core",
        is_required:   true,
        default_value: null,
        transform:     "none",
      }));
    if (toAdd.length > 0) onChange([...value, ...toAdd]);
  }

  const inputCls = "rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none";

  return (
    <div className="space-y-3">
      {/* Auto-fill button */}
      <div className="flex items-center gap-3">
        <p className="text-xs text-gray-500">
          Petakan kolom dari file Excel/CSV ke field sistem. Satu baris = satu kolom.
        </p>
        <button type="button" onClick={autoFill}
          className="ml-auto rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 shrink-0">
          ✨ Auto-isi Field Wajib
        </button>
      </div>

      {/* Header */}
      {value.length > 0 && (
        <div className="grid grid-cols-12 gap-2 px-2 text-xs font-medium text-gray-400">
          <div className="col-span-3">Kolom di File</div>
          <div className="col-span-1 flex justify-center"><ArrowRight className="h-3 w-3" /></div>
          <div className="col-span-3">Field Sistem</div>
          <div className="col-span-2">Transform</div>
          <div className="col-span-2">Default</div>
          <div className="col-span-1 text-center">Wajib</div>
        </div>
      )}

      {/* Rows */}
      {value.map((row, idx) => (
        <div key={idx} className="grid grid-cols-12 gap-2 items-center rounded-lg bg-gray-50 p-2">
          {/* Source column */}
          <div className="col-span-3">
            <input
              type="text"
              placeholder="Nama Kolom Excel"
              value={row.source_column}
              onChange={(e) => updateRow(idx, { source_column: e.target.value })}
              className={`${inputCls} w-full`}
            />
          </div>

          {/* Arrow */}
          <div className="col-span-1 flex justify-center">
            <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
          </div>

          {/* Target field */}
          <div className="col-span-3">
            <select
              value={row.target_field}
              onChange={(e) => updateRow(idx, { target_field: e.target.value, target_type: "core" })}
              className={`${inputCls} w-full`}
            >
              <optgroup label="Field Utama">
                {coreFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}{f.required ? " *" : ""}
                  </option>
                ))}
              </optgroup>
              <option value="__custom__">→ Custom Field...</option>
              <option value="__skip__">— Abaikan kolom ini —</option>
            </select>
            {row.target_field === "__custom__" && (
              <input
                type="text"
                placeholder="nama_field_kustom"
                className={`${inputCls} w-full mt-1 font-mono`}
                onChange={(e) => updateRow(idx, { target_field: e.target.value, target_type: "custom" })}
              />
            )}
          </div>

          {/* Transform */}
          <div className="col-span-2">
            <select
              value={row.transform}
              onChange={(e) => updateRow(idx, { transform: e.target.value as TransformType })}
              className={`${inputCls} w-full`}
            >
              {TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {/* Default value */}
          <div className="col-span-2">
            <input
              type="text"
              placeholder="Nilai default"
              value={row.default_value ?? ""}
              onChange={(e) => updateRow(idx, { default_value: e.target.value || null })}
              className={`${inputCls} w-full`}
            />
          </div>

          {/* Required toggle */}
          <div className="col-span-1 flex justify-center">
            <input
              type="checkbox"
              checked={row.is_required}
              onChange={(e) => updateRow(idx, { is_required: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
          </div>

          {/* Delete */}
          <button type="button" onClick={() => removeRow(idx)}
            className="col-span-12 sm:col-span-0 flex justify-end text-gray-400 hover:text-red-500 ml-auto -mt-1">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}

      {/* Add row button */}
      <button type="button" onClick={addRow}
        className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-4 py-2.5 text-xs font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 w-full justify-center">
        <Plus className="h-3.5 w-3.5" />
        Tambah Baris Mapping
      </button>

      {/* Legend */}
      <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-700 space-y-1">
        <p><strong>Cara pakai:</strong></p>
        <p>1. Isi &ldquo;Kolom di File&rdquo; dengan nama header kolom persis seperti di Excel/CSV kamu.</p>
        <p>2. Pilih &ldquo;Field Sistem&rdquo; yang sesuai dari dropdown.</p>
        <p>3. Pilih &ldquo;Transform&rdquo; jika data perlu dikonversi (misal: format nomor telepon).</p>
        <p>4. Centang &ldquo;Wajib&rdquo; jika kolom tersebut harus ada isinya di setiap baris.</p>
        <p>5. Isi &ldquo;Default&rdquo; jika kolom kosong harus diisi nilai tertentu secara otomatis.</p>
      </div>
    </div>
  );
}

export { CORE_FIELDS };
