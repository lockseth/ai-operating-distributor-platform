"use client";

import { useState, useTransition, useCallback } from "react";
import { AlertCircle, Plus, Trash2, Loader2, Package } from "lucide-react";
import type { OrderFormData, OrderItemInput } from "@/lib/orders/actions";

interface Customer { id: string; name: string; code: string; phone: string | null; area: string | null; }
interface Product  { id: string; name: string; sku: string; unit: string; price: number; }
interface SalesUser { id: string; full_name: string; }

interface OrderFormProps {
  customers:  Customer[];
  products:   Product[];
  salesUsers: SalesUser[];
  // Gate P4.01 Fase B: role sales TIDAK bisa memilih sales lain -- RPC
  // (create/update_sales_order_atomic, Gate 3E-D3-A) sudah override diam-diam
  // ke diri sendiri, jadi dropdown-nya menampilkan pilihan yang tidak nyata.
  // Untuk currentUser.isPrivileged === false, field ditampilkan read-only.
  currentUser: { id: string; full_name: string; isPrivileged: boolean };
  initialData?: Partial<OrderFormData> & { items?: OrderItemRow[] };
  action:      (data: OrderFormData) => Promise<void>;
  submitLabel?: string;
  cancelHref?: string;
}

interface OrderItemRow {
  product_id:      string;
  product_name:    string;
  unit:            string;
  unit_price:      number;
  quantity:        number;
  discount_amount: number;
  total_amount:    number;
  notes:           string;
}

function emptyItem(): OrderItemRow {
  return {
    product_id: "", product_name: "", unit: "", unit_price: 0,
    quantity: 1, discount_amount: 0, total_amount: 0, notes: "",
  };
}

function formatIDR(n: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(n);
}

function calcItemTotal(row: OrderItemRow): number {
  return Math.max(0, row.unit_price * row.quantity - row.discount_amount);
}

export function OrderForm({
  customers, products, salesUsers, currentUser,
  initialData, action, submitLabel = "Simpan", cancelHref,
}: OrderFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);

  const [customerId,    setCustomerId]    = useState(initialData?.customer_id ?? "");
  const [salesId,       setSalesId]       = useState(
    initialData?.sales_id ?? (currentUser.isPrivileged ? "" : currentUser.id)
  );
  const [deliveryDate,  setDeliveryDate]  = useState(initialData?.delivery_date ?? "");
  const [paymentTermsDays, setPaymentTermsDays] = useState(
    initialData?.payment_terms_days != null ? String(initialData.payment_terms_days) : ""
  );
  const [notes,         setNotes]         = useState(initialData?.notes ?? "");
  const [orderDiscount, setOrderDiscount] = useState(0);
  const [items,         setItems]         = useState<OrderItemRow[]>(
    initialData?.items ?? [emptyItem()]
  );

  const [productSearch,  setProductSearch]  = useState<Record<number, string>>({});
  const [customerSearch, setCustomerSearch] = useState("");

  const updateItem = useCallback((idx: number, patch: Partial<OrderItemRow>) => {
    setItems((prev) => {
      const next = [...prev];
      const updated = { ...next[idx], ...patch };
      updated.total_amount = calcItemTotal(updated);
      next[idx] = updated;
      return next;
    });
  }, []);

  function selectProduct(idx: number, productId: string) {
    const p = products.find((pr) => pr.id === productId);
    if (!p) return;
    updateItem(idx, {
      product_id:   p.id,
      product_name: p.name,
      unit:         p.unit,
      unit_price:   p.price,
      quantity:     1,
      discount_amount: 0,
      total_amount: p.price,
    });
    setProductSearch((prev) => ({ ...prev, [idx]: "" }));
  }

  function addItem() { setItems((prev) => [...prev, emptyItem()]); }

  function removeItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  const subtotal        = items.reduce((s, i) => s + i.total_amount, 0);
  const clampedDiscount = Math.min(orderDiscount, subtotal);
  const tax             = Math.round((subtotal - clampedDiscount) * 0.11);
  const grand           = Math.max(0, subtotal - clampedDiscount + tax);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!customerId) { setError("Pelanggan harus dipilih"); return; }
    const validItems = items.filter((i) => i.product_id && i.quantity > 0);
    if (validItems.length === 0) { setError("Tambahkan minimal 1 item produk"); return; }

    const trimmedTerms = paymentTermsDays.trim();
    if (trimmedTerms && (!/^\d+$/.test(trimmedTerms) || parseInt(trimmedTerms, 10) <= 0)) {
      setError("Termin pembayaran harus angka hari lebih dari 0, atau kosongkan");
      return;
    }

    const data: OrderFormData = {
      customer_id:     customerId,
      sales_id:        salesId || null,
      delivery_date:   deliveryDate || null,
      notes:           notes.trim() || null,
      discount_amount: clampedDiscount,
      payment_terms_days: trimmedTerms ? parseInt(trimmedTerms, 10) : null,
      items:           validItems.map((row): OrderItemInput => ({
        product_id:      row.product_id,
        quantity:        row.quantity,
        unit_price:      row.unit_price,
        discount_amount: row.discount_amount,
        total_amount:    row.total_amount,
        notes:           row.notes || null,
      })),
    };

    startTransition(async () => {
      try {
        await action(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Terjadi kesalahan");
      }
    });
  }

  const filteredCustomers = (() => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return customers;
    const matched = customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      (c.phone && c.phone.includes(q)) ||
      (c.area && c.area.toLowerCase().includes(q))
    );
    // Always keep currently selected customer visible in the list
    if (customerId && !matched.find((c) => c.id === customerId)) {
      const selected = customers.find((c) => c.id === customerId);
      if (selected) return [selected, ...matched];
    }
    return matched;
  })();

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

      {/* Header Order */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Informasi Order</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Pelanggan <span className="text-red-500">*</span></label>
            <div className="space-y-1.5">
              <input
                type="text"
                placeholder="Cari nama, kode, telepon, atau area..."
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className={inputCls}
              />
              <select
                value={customerId}
                onChange={(e) => { setCustomerId(e.target.value); setCustomerSearch(""); }}
                className={inputCls}
                size={customerSearch ? Math.min(filteredCustomers.length + 1, 6) : 1}
              >
                <option value="">— Pilih Pelanggan —</option>
                {filteredCustomers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code}){c.phone ? ` · ${c.phone}` : ""}{c.area ? ` · ${c.area}` : ""}
                  </option>
                ))}
              </select>
              {customerSearch.trim() && (
                <p className="text-xs text-gray-400">
                  {filteredCustomers.length} pelanggan ditemukan
                  {customerId && filteredCustomers[0]?.id === customerId && filteredCustomers.length > 1
                    ? " (termasuk pelanggan yang dipilih)"
                    : ""}
                </p>
              )}
            </div>
          </div>
          <div>
            <label className={labelCls}>Sales yang Menangani</label>
            {currentUser.isPrivileged ? (
              <select value={salesId} onChange={(e) => setSalesId(e.target.value)} className={inputCls}>
                <option value="">— Belum ditugaskan —</option>
                {salesUsers.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            ) : (
              <p className={`${inputCls} flex items-center bg-gray-50 text-gray-600`}>
                {currentUser.full_name}
              </p>
            )}
          </div>
          <div>
            <label className={labelCls}>Tanggal Kirim Diminta Customer (opsional)</label>
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)}
              className={inputCls} />
            <p className="mt-1 text-xs text-gray-400">
              Kosongkan kalau customer tidak minta tanggal spesifik. Kalau
              diisi, AI Dispatch Planner akan mengikuti tanggal ini apa
              adanya, bukan rekomendasi otomatis.
            </p>
          </div>
          <div>
            <label className={labelCls}>Termin Pembayaran / Tempo (hari, opsional)</label>
            <input type="number" min={1} step={1} placeholder="mis. 14"
              value={paymentTermsDays}
              onChange={(e) => setPaymentTermsDays(e.target.value)}
              className={inputCls} />
            <p className="mt-1 text-xs text-gray-400">
              Kosongkan kalau bayar tunai/COD. Kalau diisi, akan muncul
              sebagai baris &quot;Tempo&quot; di invoice/nota tercetak.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Catatan</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Instruksi pengiriman, catatan khusus..."
              rows={2} className={`${inputCls} resize-none`} />
          </div>
        </div>
      </div>

      {/* Items */}
      <div className={section}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Item Produk</h2>
          <button type="button" onClick={addItem}
            className="flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100">
            <Plus className="h-3.5 w-3.5" />
            Tambah Item
          </button>
        </div>

        <div className="space-y-3">
          {items.map((item, idx) => {
            const search   = productSearch[idx] ?? "";
            const filtered = search.length > 0
              ? products.filter((p) =>
                  p.name.toLowerCase().includes(search.toLowerCase()) ||
                  p.sku.toLowerCase().includes(search.toLowerCase())
                ).slice(0, 8)
              : [];

            return (
              <div key={idx} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="grid grid-cols-12 gap-2 items-start">
                  {/* Product selector */}
                  <div className="col-span-12 sm:col-span-4 relative">
                    <label className="block text-xs text-gray-500 mb-1">Produk</label>
                    {item.product_id ? (
                      <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
                        <Package className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-900 truncate">{item.product_name}</p>
                          <p className="text-xs text-gray-400">{item.unit}</p>
                        </div>
                        <button type="button" onClick={() => updateItem(idx, { product_id: "", product_name: "", unit: "" })}
                          className="text-gray-400 hover:text-red-500">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          placeholder="Ketik nama / SKU..."
                          value={search}
                          onChange={(e) => setProductSearch((prev) => ({ ...prev, [idx]: e.target.value }))}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:border-blue-500 focus:outline-none"
                        />
                        {filtered.length > 0 && (
                          <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
                            {filtered.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => selectProduct(idx, p.id)}
                                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-blue-50"
                              >
                                <span className="font-medium text-gray-900">{p.name}</span>
                                <span className="text-gray-400">{formatIDR(p.price)}/{p.unit}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Qty */}
                  <div className="col-span-4 sm:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Qty</label>
                    <input type="number" min={1} value={item.quantity}
                      onChange={(e) => updateItem(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-full rounded-lg border border-gray-200 px-2 py-2 text-xs text-center focus:border-blue-500 focus:outline-none" />
                  </div>

                  {/* Harga satuan */}
                  <div className="col-span-8 sm:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">Harga Satuan (Rp)</label>
                    <input type="number" min={0} value={item.unit_price}
                      onChange={(e) => updateItem(idx, { unit_price: parseFloat(e.target.value) || 0 })}
                      className="w-full rounded-lg border border-gray-200 px-2 py-2 text-xs focus:border-blue-500 focus:outline-none" />
                  </div>

                  {/* Diskon */}
                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Diskon (Rp)</label>
                    <input type="number" min={0} value={item.discount_amount}
                      onChange={(e) => updateItem(idx, { discount_amount: parseFloat(e.target.value) || 0 })}
                      className="w-full rounded-lg border border-gray-200 px-2 py-2 text-xs focus:border-blue-500 focus:outline-none" />
                  </div>

                  {/* Total */}
                  <div className="col-span-5 sm:col-span-1">
                    <label className="block text-xs text-gray-500 mb-1">Total</label>
                    <p className="py-2 text-xs font-semibold text-gray-900 text-right">
                      {formatIDR(item.total_amount)}
                    </p>
                  </div>

                  {/* Hapus */}
                  <div className="col-span-1 flex items-end justify-end pb-1">
                    {items.length > 1 && (
                      <button type="button" onClick={() => removeItem(idx)}
                        className="text-gray-400 hover:text-red-500 p-1">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">Ringkasan Harga</h2>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Subtotal</span>
            <span className="font-medium">{formatIDR(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-600">Diskon Order</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Rp</span>
              <input type="number" min={0} value={orderDiscount}
                onChange={(e) => setOrderDiscount(parseFloat(e.target.value) || 0)}
                className={`w-28 rounded-lg border px-2 py-1 text-xs text-right focus:border-blue-500 focus:outline-none ${orderDiscount > subtotal && subtotal > 0 ? "border-amber-400 bg-amber-50" : "border-gray-200"}`} />
            </div>
          </div>
          {orderDiscount > subtotal && subtotal > 0 && (
            <p className="text-xs text-amber-600 text-right">
              Diskon dikurangi otomatis ke {formatIDR(subtotal)} (maks. subtotal)
            </p>
          )}
          <div className="flex justify-between">
            <span className="text-gray-600">PPN 11%</span>
            <span className="font-medium">{formatIDR(tax)}</span>
          </div>
          <div className="flex justify-between border-t border-gray-100 pt-2 text-base">
            <span className="font-semibold text-gray-900">Total Tagihan</span>
            <span className="font-bold text-blue-700">{formatIDR(grand)}</span>
          </div>
        </div>
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
