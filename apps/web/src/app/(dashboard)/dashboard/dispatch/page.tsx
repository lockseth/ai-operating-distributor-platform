import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingSpinner } from "@/components/ui/loading-state";
import { DispatchStatusBadge } from "@/components/dispatch/dispatch-status-badge";
import { GeneratePlanButton } from "@/components/dispatch/generate-plan-button";
import { Route } from "lucide-react";
import { CONFLICT_STATUSES } from "@/lib/dispatch/types";

export const metadata = { title: "AI Dispatch Planner — AODP" };

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

interface DispatchPlanRow {
  id: string;
  planning_status: string;
  delivery_date: string | null;
  delivery_area: string | null;
  delivery_group_key: string | null;
  planning_reason: string;
  confidence_score: number;
  is_override: boolean;
  sales_order: { order_number: string; customer: { name: string } | null } | null;
  assigned_actor: { full_name: string } | null;
}

interface CandidateOrderRow {
  id: string;
  order_number: string;
  customer: { name: string } | null;
}

async function DispatchPlanList({ companyId }: { companyId: string }) {
  const supabase = await createClient();

  const [plansResult, plannedOrderIdsResult] = await Promise.all([
    supabase
      .from("dispatch_plans")
      .select(
        "id, planning_status, delivery_date, delivery_area, delivery_group_key, planning_reason, confidence_score, is_override, " +
          "sales_order:sales_orders!sales_order_id(order_number, customer:customers!customer_id(name)), " +
          "assigned_actor:users!assigned_actor_id(full_name)"
      )
      .eq("company_id", companyId)
      .order("delivery_date", { ascending: true, nullsFirst: true })
      .order("delivery_group_key", { ascending: true })
      .limit(100),
    supabase.from("dispatch_plans").select("sales_order_id").eq("company_id", companyId),
  ]);

  const plans = (plansResult.data ?? []) as unknown as DispatchPlanRow[];
  const plannedOrderIds = new Set((plannedOrderIdsResult.data ?? []).map((r) => r.sales_order_id as string));

  const { data: confirmedOrders } = await supabase
    .from("sales_orders")
    .select("id, order_number, customer:customers!customer_id(name)")
    .eq("company_id", companyId)
    .eq("status", "confirmed")
    .order("created_at", { ascending: false })
    .limit(50);

  const candidateOrders = ((confirmedOrders ?? []) as unknown as CandidateOrderRow[]).filter(
    (o) => !plannedOrderIds.has(o.id)
  );

  if (plans.length === 0 && candidateOrders.length === 0) {
    return (
      <EmptyState
        icon={<Route className="h-10 w-10 text-gray-300" />}
        title="Belum ada dispatch plan"
        description="Rencana pengiriman akan muncul di sini setelah ada sales order yang confirmed dan direncanakan oleh AI Dispatch Planner."
      />
    );
  }

  return (
    <div className="space-y-5">
      {candidateOrders.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-900">Order Menunggu Perencanaan</h2>
            <p className="text-xs text-gray-500 mt-0.5">Order confirmed yang belum memiliki dispatch plan.</p>
          </div>
          <div className="divide-y divide-gray-50">
            {candidateOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="font-mono text-xs font-semibold text-gray-800">{o.order_number}</span>
                  <p className="text-sm text-gray-600">{o.customer?.name ?? "—"}</p>
                </div>
                <GeneratePlanButton salesOrderId={o.id} />
              </div>
            ))}
          </div>
        </div>
      )}

      {plans.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Dispatch Plan</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {plans.length} order dalam rencana pengiriman. Urutan kunjungan per rute belum tersedia (Route
                Intelligence — fase berikutnya).
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">No. Order</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Toko</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Tgl. Kirim</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Area / Grup</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Salesman</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Alasan AI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {plans.map((p) => (
                  <tr key={p.id} className={CONFLICT_STATUSES.includes(p.planning_status as never) ? "bg-red-50/40" : undefined}>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-semibold text-gray-800">{p.sales_order?.order_number ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{p.sales_order?.customer?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{formatDate(p.delivery_date)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{p.delivery_group_key ?? p.delivery_area ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{p.assigned_actor?.full_name ?? "Belum ditugaskan"}</td>
                    <td className="px-4 py-3 text-center">
                      <DispatchStatusBadge status={p.planning_status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 max-w-xs">
                      <p>{p.planning_reason || "—"}</p>
                      {p.is_override && <span className="text-amber-600">Hasil override manusia</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default async function DispatchPlannerPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "dispatch.view")) redirect("/dashboard");

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="AI Dispatch Planner"
        subtitle="Rencana pengiriman otomatis dari AI berdasarkan area, stok, dan permintaan toko — salesman membawa pesanan sesuai jadwal."
      />

      <Suspense fallback={<div className="p-8 flex justify-center"><LoadingSpinner /></div>}>
        <DispatchPlanList companyId={user.company_id} />
      </Suspense>
    </div>
  );
}
