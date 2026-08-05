import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { CustomerFilters } from "@/components/customers/customer-filters";
import { Plus, Users, Edit2 } from "lucide-react";

export const metadata = { title: "Pelanggan — AODP" };

const PAGE_SIZE = 20;

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  type: string;
  phone: string | null;
  city: string | null;
  area: string | null;
  is_active: boolean;
  last_order_at: string | null;
  users: { full_name: string } | null;
}

interface SalesUser { id: string; full_name: string; }

interface SearchParams {
  q?: string;
  city?: string;
  area?: string;
  sales?: string;
  status?: string;
  page?: string;
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

const TYPE_LABELS: Record<string, string> = {
  reseller:     "Reseller",
  direct:       "Direct",
  distributor:  "Distributor",
  modern_trade: "Modern Trade",
};

async function CustomerTable({
  companyId,
  params,
  canEdit,
}: {
  companyId: string;
  params: SearchParams;
  canEdit: boolean;
}) {
  const q      = params.q ?? "";
  const city   = params.city ?? "";
  const area   = params.area ?? "";
  const sales  = params.sales ?? "";
  const status = params.status ?? "active";
  const page   = Math.max(1, parseInt(params.page ?? "1"));
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("customers")
    .select(
      "id, code, name, type, phone, city, area, is_active, last_order_at, users!assigned_sales_id(full_name)",
      { count: "exact" }
    )
    .eq("company_id", companyId)
    .order("name", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  if (q)      query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,city.ilike.%${q}%,area.ilike.%${q}%`);
  if (city)   query = query.eq("city", city);
  if (area)   query = query.eq("area", area);
  if (sales)  query = query.eq("assigned_sales_id", sales);
  if (status === "active")   query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);

  const { data, count } = await query;

  const customers   = (data ?? []) as unknown as CustomerRow[];
  const totalCount  = count ?? 0;
  const totalPages  = Math.ceil(totalCount / PAGE_SIZE);

  if (customers.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-10 w-10 text-gray-300" />}
        title="Tidak ada pelanggan ditemukan"
        description={q || city || area || sales || status !== "active"
          ? "Coba ubah filter pencarian"
          : "Belum ada pelanggan. Klik 'Tambah Pelanggan' untuk memulai."}
      />
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Kode</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Nama Toko</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Tipe</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Telepon</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Kota / Area</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Sales</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Order Terakhir</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {customers.map((c) => (
              <tr key={c.id} className="group hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="font-mono text-xs text-gray-500">{c.code}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="font-medium text-gray-900">{c.name}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500">{TYPE_LABELS[c.type] ?? c.type}</span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{c.phone ?? "—"}</td>
                <td className="px-4 py-3">
                  <div className="text-xs text-gray-700">{c.city ?? "—"}</div>
                  {c.area && <div className="text-xs text-gray-400">{c.area}</div>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {c.users?.full_name ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {formatDate(c.last_order_at) ?? <span className="text-gray-300">Belum order</span>}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    c.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                  }`}>
                    {c.is_active ? "Aktif" : "Nonaktif"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {canEdit && (
                      <Link
                        href={`/dashboard/customers/${c.id}/edit`}
                        aria-label={`Edit ${c.name}`}
                        className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-700"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                        Edit
                      </Link>
                    )}
                    <Link
                      href={`/dashboard/customers/${c.id}`}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800"
                    >
                      Detail →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3">
          <p className="text-sm text-gray-500">
            Menampilkan {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} dari {totalCount.toLocaleString("id-ID")} pelanggan
          </p>
          <div className="flex gap-1">
            {page > 1 && <PaginationLink page={page - 1} params={params} label="← Sebelumnya" />}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const p = Math.max(1, Math.min(page - 2, totalPages - 4)) + i;
              return <PaginationLink key={p} page={p} params={params} label={String(p)} isActive={p === page} />;
            })}
            {page < totalPages && <PaginationLink page={page + 1} params={params} label="Berikutnya →" />}
          </div>
        </div>
      )}
    </div>
  );
}

function PaginationLink({ page, params, label, isActive }: {
  page: number; params: SearchParams; label: string; isActive?: boolean;
}) {
  const sp = new URLSearchParams();
  if (params.q)      sp.set("q", params.q);
  if (params.city)   sp.set("city", params.city);
  if (params.area)   sp.set("area", params.area);
  if (params.sales)  sp.set("sales", params.sales);
  if (params.status) sp.set("status", params.status);
  sp.set("page", String(page));
  return (
    <Link
      href={`/dashboard/customers?${sp.toString()}`}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium transition-colors ${
        isActive ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </Link>
  );
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "customers.view")) redirect("/dashboard");

  const supabase = await createClient();

  // Distinct cities, areas, sales users — for filter dropdowns
  const [citiesResult, areasResult, salesResult, countResult] = await Promise.all([
    supabase
      .from("customers")
      .select("city")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .not("city", "is", null)
      .order("city"),

    supabase
      .from("customers")
      .select("area")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .not("area", "is", null)
      .order("area"),

    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .contains("roles", ["sales"])
      .order("full_name"),

    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("company_id", user.company_id)
      .eq("is_active", params.status === "inactive" ? false : params.status === "all" ? undefined! : true),
  ]);

  // De-dup cities and areas
  const cities     = [...new Set((citiesResult.data ?? []).map((r: { city: string | null }) => r.city).filter(Boolean))] as string[];
  const areas      = [...new Set((areasResult.data ?? []).map((r: { area: string | null }) => r.area).filter(Boolean))] as string[];
  const salesUsers = (salesResult.data ?? []) as unknown as SalesUser[];

  const canCreate = hasPermission(user.permissions, "customers.create");
  const canEdit   = hasPermission(user.permissions, "customers.update");

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Manajemen Pelanggan"
        subtitle="Kelola data reseller dan pelanggan bisnis"
      >
        {canCreate && (
          <Link
            href="/dashboard/customers/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Tambah Pelanggan
          </Link>
        )}
      </PageHeader>

      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <CustomerFilters
          cities={cities}
          areas={areas}
          salesUsers={salesUsers}
          totalCount={countResult.count ?? 0}
        />
      </div>

      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <Suspense fallback={<div className="p-8 flex justify-center"><LoadingSpinner /></div>}>
          <CustomerTable companyId={user.company_id} params={params} canEdit={canEdit} />
        </Suspense>
      </div>
    </div>
  );
}
