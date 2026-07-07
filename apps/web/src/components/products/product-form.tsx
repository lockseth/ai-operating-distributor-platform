"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProductFormData } from "@/lib/products/actions";
import { AlertCircle, Loader2 } from "lucide-react";

interface Category {
  id: string;
  name: string;
}

interface ProductFormProps {
  initialData?: Partial<ProductFormData>;
  categories: Category[];
  action: (data: ProductFormData) => Promise<void>;
  submitLabel?: string;
  cancelHref?: string;
}

const UNIT_OPTIONS = ["pcs", "botol", "box", "karton", "liter", "kg", "gram", "lembar", "lusin", "set"];

function toNumber(val: string, fallback = 0): number {
  const n = parseFloat(val.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? fallback : n;
}

export function ProductForm({
  initialData,
  categories,
  action,
  submitLabel = "Simpan",
  cancelHref = "/dashboard/products",
}: ProductFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName]               = useState(initialData?.name ?? "");
  const [sku, setSku]                 = useState(initialData?.sku ?? "");
  const [categoryId, setCategoryId]   = useState(initialData?.category_id ?? "");
  const [unit, setUnit]               = useState(initialData?.unit ?? "pcs");
  const [customUnit, setCustomUnit]   = useState(
    initialData?.unit && !UNIT_OPTIONS.includes(initialData.unit) ? initialData.unit : ""
  );
  const [price, setPrice]             = useState(String(initialData?.price ?? ""));
  const [cost, setCost]               = useState(String(initialData?.cost ?? ""));
  const [stock, setStock]             = useState(String(initialData?.stock_quantity ?? "0"));
  const [minStock, setMinStock]       = useState(String(initialData?.min_stock ?? "0"));
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [isActive, setIsActive]       = useState(initialData?.is_active ?? true);

  const isEditMode = initialData !== undefined && "name" in initialData;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side validation
    if (!name.trim()) { setError("Nama produk wajib diisi"); return; }
    if (!sku.trim())  { setError("SKU wajib diisi"); return; }
    const priceNum = toNumber(price);
    if (priceNum < 0) { setError("Harga tidak boleh negatif"); return; }

    const resolvedUnit = unit === "__custom__" ? customUnit.trim() || "pcs" : unit;
    const formData: ProductFormData = {
      name: name.trim(),
      sku: sku.trim(),
      category_id: categoryId || null,
      unit: resolvedUnit,
      price: priceNum,
      cost: cost ? toNumber(cost) : null,
      stock_quantity: toNumber(stock, 0),
      min_stock: toNumber(minStock, 0),
      description: description.trim() || null,
      is_active: isActive,
    };

    startTransition(async () => {
      try {
        await action(formData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan. Silakan coba lagi.");
      }
    });
  }

  const inputCls = "block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500";
  const labelCls = "block text-sm font-medium text-gray-700 mb-1";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Error banner */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Section 1: Informasi Dasar ── */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Informasi Dasar</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Nama Produk */}
          <div className="sm:col-span-2">
            <label className={labelCls}>
              Nama Produk <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Air Mineral Botol 600 ml"
              className={inputCls}
              disabled={isPending}
              maxLength={255}
            />
          </div>

          {/* SKU */}
          <div>
            <label className={labelCls}>
              SKU <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value.toUpperCase())}
              placeholder="Contoh: AQB-600"
              className={`${inputCls} font-mono`}
              disabled={isPending}
              maxLength={100}
            />
            <p className="mt-1 text-xs text-gray-400">Kode unik produk — akan digunakan di invoice</p>
          </div>

          {/* Kategori */}
          <div>
            <label className={labelCls}>Kategori</label>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className={inputCls}
              disabled={isPending}
            >
              <option value="">— Tanpa Kategori —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Satuan */}
          <div>
            <label className={labelCls}>Satuan <span className="text-red-500">*</span></label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className={inputCls}
              disabled={isPending}
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
              <option value="__custom__">Lainnya…</option>
            </select>
            {unit === "__custom__" && (
              <input
                type="text"
                value={customUnit}
                onChange={(e) => setCustomUnit(e.target.value)}
                placeholder="Masukkan satuan…"
                className={`${inputCls} mt-2`}
                disabled={isPending}
              />
            )}
          </div>

          {/* Deskripsi */}
          <div className="sm:col-span-2">
            <label className={labelCls}>Deskripsi</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Deskripsi singkat produk (opsional)"
              rows={3}
              className={inputCls}
              disabled={isPending}
            />
          </div>
        </div>
      </div>

      {/* ── Section 2: Harga ── */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Harga</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Harga Jual */}
          <div>
            <label className={labelCls}>Harga Jual (Rp) <span className="text-red-500">*</span></label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">Rp</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
                min="0"
                step="100"
                className={`${inputCls} pl-9`}
                disabled={isPending}
              />
            </div>
          </div>

          {/* HPP */}
          <div>
            <label className={labelCls}>HPP / Harga Modal (Rp)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">Rp</span>
              <input
                type="number"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0"
                min="0"
                step="100"
                className={`${inputCls} pl-9`}
                disabled={isPending}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">Tidak ditampilkan ke sales. Digunakan untuk kalkulasi margin.</p>
          </div>
        </div>
      </div>

      {/* ── Section 3: Stok ── */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-sm font-semibold text-gray-900">Stok</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Stok Saat Ini</label>
            <input
              type="number"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              min="0"
              className={inputCls}
              disabled={isPending}
            />
          </div>
          <div>
            <label className={labelCls}>Stok Minimum</label>
            <input
              type="number"
              value={minStock}
              onChange={(e) => setMinStock(e.target.value)}
              min="0"
              className={inputCls}
              disabled={isPending}
            />
            <p className="mt-1 text-xs text-gray-400">Trigger alert jika stok di bawah angka ini</p>
          </div>
        </div>
      </div>

      {/* ── Section 4: Status (edit only) ── */}
      {isEditMode && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">Status</h2>
          <label className="flex cursor-pointer items-center gap-3">
            <div className="relative">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="sr-only"
                disabled={isPending}
              />
              <div
                className={`h-5 w-9 rounded-full transition-colors ${isActive ? "bg-blue-600" : "bg-gray-300"}`}
              />
              <div
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isActive ? "translate-x-4" : "translate-x-0"}`}
              />
            </div>
            <span className="text-sm text-gray-900">
              {isActive ? "Produk Aktif — ditampilkan dan dapat dipesan" : "Produk Nonaktif — disembunyikan dari daftar"}
            </span>
          </label>
        </div>
      )}

      {/* ── Action Buttons ── */}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => router.push(cancelHref)}
          disabled={isPending}
          className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Batal
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
