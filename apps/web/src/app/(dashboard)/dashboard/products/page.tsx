import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { ProductFilters } from "@/components/products/product-filters";
import { Plus, Package, AlertTriangle } from "lucide-react";

export const metadata = { title: "Produk — AODP" };

const PAGE_SIZE = 20;

function formatIDR(amount: number) {
  if (amount >= 1_000_000) return `Rp${(amount / 1_000_000).toFixed(1)}jt`;
  if (amount >= 1_000)     return `Rp${(amount / 1_000).toFixed(0)}rb`;
  return `Rp${amount.toLocaleString("id-ID")}`;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  unit: string;
  price: number;
  cost: number | null;
  stock_quantity: number;
  min_stock: number;
  is_active: boolean;
  product_categories: { name: string } | null;
}

interface Category { id: string; name: string; }

interface SearchParams { q?: string; category?: string; status?: string; page?: string; }

async function ProductTable({
  companyId,
  params,
}: {
  companyId: string;
  params: SearchParams;
}) {
  const q          = params.q ?? "";
  const categoryId = params.category ?? "";
  const status     = params.status ?? "active";
  const page       = Math.max(1, parseInt(params.page ?? "1"));
  const offset     = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("products")
    .select(
      "id, sku, name, unit, price, cost, stock_quantity, min_stock, is_active, product_categories(name)",
      { count: "exact" }
    )
    .eq("company_id", companyId)
    .order("name", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (q)          query = query.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);
  if (categoryId) query = query.eq("category_id", categoryId);
  if (status === "active")   query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);

  const { data, count } = await query;

  const products = (data ?? []) as unknown as ProductRow[];
  const totalCount = count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  if (products.length === 0) {
    return (
      <EmptyState
        icon={<Package className="h-10 w-10 text-gray-300" />}
        title="Tidak ada produk ditemukan"
        description={q || categoryId || status !== "active"
          ? "Coba ubah filter pencarian"
          : "Belum ada produk. Klik tombol 'Tambah Produk' untuk memulai."}
      />
    );
  }

  return (
    <div>
      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">SKU</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Nama Produk</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Kategori</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Satuan</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Harga Jual</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Stok</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {products.map((p) => {
              const isLowStock = p.stock_quantity <= p.min_stock && p.min_stock > 0;
              return (
                <tr key={p.id} className="group hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-600">{p.sku}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      {isLowStock && (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-gray-500">
                      {p.product_categories?.name ?? <span className="text-gray-300">—</span>}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{p.unit}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {formatIDR(p.price)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={isLowStock ? "font-semibold text-amber-600" : "text-gray-900"}>
                      {p.stock_quantity.toLocaleString("id-ID")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                    }`}>
                      {p.is_active ? "Aktif" : "Nonaktif"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/dashboard/products/${p.id}`}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      Detail →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
          <p className="text-sm text-gray-500">
            Menampilkan {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} dari {totalCount.toLocaleString("id-ID")} produk
          </p>
          <div className="flex gap-1">
            {page > 1 && (
              <PaginationLink page={page - 1} params={params} label="← Sebelumnya" />
            )}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
              return (
                <PaginationLink
                  key={p} page={p} params={params}
                  label={String(p)} isActive={p === page}
                />
              );
            })}
            {page < totalPages && (
              <PaginationLink page={page + 1} params={params} label="Berikutnya →" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PaginationLink({
  page, params, label, isActive,
}: {
  page: number; params: SearchParams; label: string; isActive?: boolean;
}) {
  const sp = new URLSearchParams();
  if (params.q)        sp.set("q", params.q);
  if (params.category) sp.set("category", params.category);
  if (params.status)   sp.set("status", params.status);
  sp.set("page", String(page));

  return (
    <Link
      href={`/dashboard/products?${sp.toString()}`}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors ${
        isActive
          ? "bg-blue-600 text-white"
          : "border border-gray-200 text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "products.view")) {
    redirect("/dashboard");
  }

  const supabase = await createClient();

  // Fetch categories for filter dropdown
  const { data: categoriesData } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("company_id", user.company_id)
    .order("name");

  const categories = (categoriesData ?? []) as unknown as Category[];

  // Fetch total count for display (respecting current filters)
  let countQuery = supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("company_id", user.company_id);

  const status = params.status ?? "active";
  if (status === "active")   countQuery = countQuery.eq("is_active", true);
  if (status === "inactive") countQuery = countQuery.eq("is_active", false);
  if (params.q) countQuery = countQuery.or(`name.ilike.%${params.q}%,sku.ilike.%${params.q}%`);
  if (params.category) countQuery = countQuery.eq("category_id", params.category);

  const { count } = await countQuery;

  const canCreate = hasPermission(user.permissions, "products.create");

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Manajemen Produk"
        subtitle="Kelola katalog produk, harga, dan stok"
      >
        {canCreate && (
          <Link
            href="/dashboard/products/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Tambah Produk
          </Link>
        )}
      </PageHeader>

      {/* Filters */}
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <ProductFilters categories={categories} totalCount={count ?? 0} />
      </div>

      {/* Product Table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <Suspense fallback={<div className="p-8 flex justify-center"><LoadingSpinner /></div>}>
          <ProductTable companyId={user.company_id} params={params} />
        </Suspense>
      </div>
    </div>
  );
}
