import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { OrderFilters } from "@/components/orders/order-filters";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { Plus, ShoppingCart } from "lucide-react";

export const metadata = { title: "Sales Order — AODP" };

const PAGE_SIZE = 20;

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  final_amount: number;
  delivery_date: string | null;
  created_at: string;
  customer: { name: string; phone: string | null } | null;
  sales:    { full_name: string } | null;
}

interface SalesUser { id: string; full_name: string; }

interface SearchParams {
  q?: string;
  status?: string;
  sales?: string;
  date_from?: string;
  date_to?: string;
  page?: string;
}

function formatIDR(n: number) {
  if (n >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (n >= 1_000)     return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

async function OrderTable({
  companyId,
  params,
}: {
  companyId: string;
  params: SearchParams;
}) {
  const q         = params.q ?? "";
  const status    = params.status ?? "";
  const sales     = params.sales ?? "";
  const dateFrom  = params.date_from ?? "";
  const dateTo    = params.date_to ?? "";
  const page      = Math.max(1, parseInt(params.page ?? "1"));
  const offset    = (page - 1) * PAGE_SIZE;

  const supabase = await createClient();

  let query = supabase
    .from("sales_orders")
    .select(
      "id, order_number, status, final_amount, delivery_date, created_at, customer:customers!customer_id(name, phone), sales:users!sales_id(full_name)",
      { count: "exact" }
    )
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (status)   query = query.eq("status", status);
  if (sales)    query = query.eq("sales_id", sales);
  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo)   query = query.lte("created_at", `${dateTo}T23:59:59`);

  const { data, count } = await query;
  let orders = (data ?? []) as unknown as OrderRow[];

  // Client-side search for order_number + customer name/phone (Supabase FK join filter is limited)
  if (q) {
    const ql = q.toLowerCase();
    orders = orders.filter((o) =>
      o.order_number.toLowerCase().includes(ql) ||
      o.customer?.name?.toLowerCase().includes(ql) ||
      (o.customer?.phone ?? "").includes(ql)
    );
  }

  const totalCount = count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  if (orders.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingCart className="h-10 w-10 text-gray-300" />}
        title="Tidak ada order ditemukan"
        description={q || status || sales || dateFrom || dateTo
          ? "Coba ubah filter pencarian"
          : "Belum ada sales order. Klik 'Buat Order' untuk memulai."}
      />
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">No. Order</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Pelanggan</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Sales</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Tgl. Kirim</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Dibuat</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map((o) => (
              <tr key={o.id} className="group hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="font-mono text-xs font-semibold text-gray-800">{o.order_number}</span>
                </td>
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900 text-sm">{o.customer?.name ?? "—"}</p>
                  {o.customer?.phone && <p className="text-xs text-gray-400">{o.customer.phone}</p>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{o.sales?.full_name ?? "—"}</td>
                <td className="px-4 py-3 text-center">
                  <OrderStatusBadge status={o.status} />
                </td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">
                  {formatIDR(o.final_amount)}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {formatDate(o.delivery_date) ?? "—"}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {formatDate(o.created_at)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/dashboard/orders/${o.id}`}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800 opacity-0 group-hover:opacity-100 transition-opacity">
                    Detail →
                  </Link>
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
            Menampilkan {offset + 1}–{Math.min(offset + PAGE_SIZE, totalCount)} dari {totalCount.toLocaleString("id-ID")} order
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
  if (params.q)         sp.set("q", params.q);
  if (params.status)    sp.set("status", params.status);
  if (params.sales)     sp.set("sales", params.sales);
  if (params.date_from) sp.set("date_from", params.date_from);
  if (params.date_to)   sp.set("date_to", params.date_to);
  sp.set("page", String(page));
  return (
    <Link href={`/dashboard/orders?${sp.toString()}`}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium ${
        isActive ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"
      }`}>
      {label}
    </Link>
  );
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "orders.view")) redirect("/dashboard");

  const supabase = await createClient();

  const [salesResult, countResult] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .contains("roles", ["sales"])
      .order("full_name"),

    supabase
      .from("sales_orders")
      .select("id", { count: "exact", head: true })
      .eq("company_id", user.company_id),
  ]);

  const salesUsers = (salesResult.data ?? []) as unknown as SalesUser[];
  const canCreate  = hasPermission(user.permissions, "orders.create");

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Sales Order"
        subtitle="Kelola pesanan penjualan dari pelanggan"
      >
        {canCreate && (
          <Link href="/dashboard/orders/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Plus className="h-4 w-4" />
            Buat Order
          </Link>
        )}
      </PageHeader>

      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <OrderFilters salesUsers={salesUsers} totalCount={countResult.count ?? 0} />
      </div>

      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <Suspense fallback={<div className="p-8 flex justify-center"><LoadingSpinner /></div>}>
          <OrderTable companyId={user.company_id} params={params} />
        </Suspense>
      </div>
    </div>
  );
}
