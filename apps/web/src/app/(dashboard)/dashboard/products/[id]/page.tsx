import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { ArchiveButton } from "@/components/products/archive-button";
import {
  ChevronLeft, Edit2, Package, Tag, DollarSign,
  Layers, AlertTriangle, Info,
} from "lucide-react";

export const metadata = { title: "Detail Produk — AODP" };

function formatIDR(amount: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency", currency: "IDR", maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  price: number;
  cost: number | null;
  stock_quantity: number;
  min_stock: number;
  is_active: boolean;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  product_categories: { name: string } | null;
  users: { full_name: string } | null;
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "products.view")) {
    redirect("/dashboard/products");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("products")
    .select("*, product_categories(name), users!created_by(full_name)")
    .eq("id", id)
    .eq("company_id", user.company_id)
    .single();

  if (!data) notFound();

  const product = data as unknown as Product;
  const canEdit    = hasPermission(user.permissions, "products.update");
  const canArchive = hasPermission(user.permissions, "products.delete") || canEdit;

  const isLowStock = product.stock_quantity <= product.min_stock && product.min_stock > 0;
  const margin = product.cost && product.price > 0
    ? Math.round(((product.price - product.cost) / product.price) * 100)
    : null;

  // Filter out empty custom fields
  const customFieldEntries = Object.entries(product.custom_fields ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      {/* Breadcrumb + Actions */}
      <div className="flex items-center justify-between">
        <Link href="/dashboard/products" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Produk
        </Link>
        <div className="flex items-center gap-2">
          {canArchive && (
            <ArchiveButton productId={product.id} isActive={product.is_active} />
          )}
          {canEdit && (
            <Link
              href={`/dashboard/products/${product.id}/edit`}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Edit2 className="h-4 w-4" />
              Edit Produk
            </Link>
          )}
        </div>
      </div>

      {/* Header Card */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50">
              <Package className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-xl font-bold text-gray-900">{product.name}</h1>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  product.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                }`}>
                  {product.is_active ? "Aktif" : "Nonaktif"}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm text-gray-500">
                <span className="font-mono">{product.sku}</span>
                {product.product_categories && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Tag className="h-3.5 w-3.5" />
                      {product.product_categories.name}
                    </span>
                  </>
                )}
                <span>·</span>
                <span>per {product.unit}</span>
              </div>
              {product.description && (
                <p className="mt-2 text-sm text-gray-600 max-w-xl">{product.description}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* Harga Jual */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-gray-500">Harga Jual</span>
          </div>
          <p className="text-lg font-bold text-gray-900">{formatIDR(product.price)}</p>
          <p className="text-xs text-gray-400 mt-0.5">per {product.unit}</p>
        </div>

        {/* HPP & Margin */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-purple-500" />
            <span className="text-xs text-gray-500">HPP / Modal</span>
          </div>
          <p className="text-lg font-bold text-gray-900">
            {product.cost ? formatIDR(product.cost) : <span className="text-gray-300">—</span>}
          </p>
          {margin !== null && (
            <p className="text-xs font-medium text-green-600 mt-0.5">Margin {margin}%</p>
          )}
        </div>

        {/* Stok */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Layers className="h-4 w-4 text-green-500" />
            <span className="text-xs text-gray-500">Stok Saat Ini</span>
          </div>
          <div className="flex items-center gap-1.5">
            <p className={`text-lg font-bold ${isLowStock ? "text-amber-600" : "text-gray-900"}`}>
              {product.stock_quantity.toLocaleString("id-ID")}
            </p>
            {isLowStock && <AlertTriangle className="h-4 w-4 text-amber-500" aria-label="Stok rendah" />}
          </div>
          <p className="text-xs text-gray-400 mt-0.5">Min. {product.min_stock} {product.unit}</p>
        </div>

        {/* Status Stok */}
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Info className="h-4 w-4 text-gray-400" />
            <span className="text-xs text-gray-500">Status Stok</span>
          </div>
          <p className={`text-sm font-semibold mt-1 ${
            product.stock_quantity === 0 ? "text-red-600"
            : isLowStock ? "text-amber-600"
            : "text-green-600"
          }`}>
            {product.stock_quantity === 0 ? "Habis" : isLowStock ? "Stok Rendah" : "Tersedia"}
          </p>
        </div>
      </div>

      {/* Custom Fields */}
      {customFieldEntries.length > 0 && (
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Field Tambahan</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {customFieldEntries.map(([key, value]) => (
              <div key={key} className="rounded-lg bg-gray-50 p-3">
                <p className="text-xs text-gray-500 capitalize">{key.replace(/_/g, " ")}</p>
                <p className="text-sm font-medium text-gray-900 mt-0.5">{String(value)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="rounded-xl border bg-gray-50 p-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
          <span>Dibuat: {formatDate(product.created_at)}</span>
          {product.users?.full_name && (
            <span>oleh {product.users.full_name}</span>
          )}
          <span>Terakhir diubah: {formatDate(product.updated_at)}</span>
          <span className="font-mono">ID: {product.id}</span>
        </div>
      </div>
    </div>
  );
}
