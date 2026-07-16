import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { listSalesmenAction } from "@/lib/dispatch/actions";
import { computeHasHumanReview } from "@/lib/dispatch/workflow";
import { DispatchStatusBadge } from "@/components/dispatch/dispatch-status-badge";
import { AssignSalesmanForm } from "@/components/dispatch/assign-salesman-form";
import { AcceptPlanButton } from "@/components/dispatch/accept-plan-button";
import { HoldPlanForm } from "@/components/dispatch/hold-plan-form";
import { ChevronLeft, CheckCircle2, Clock, Route, Sparkles, UserCog } from "lucide-react";
import type { PlanningStatus } from "@/lib/dispatch/types";

export const metadata = { title: "Review Dispatch Plan — AODP" };

const ACCEPTABLE_FOR_REVIEW: readonly PlanningStatus[] = ["planned", "scheduled", "ready_for_delivery"];

interface PlanDetailRow {
  id: string;
  planning_status: PlanningStatus;
  delivery_date: string | null;
  delivery_area: string | null;
  delivery_group_key: string | null;
  assigned_actor_id: string | null;
  planning_reason: string;
  confidence_score: number;
  is_override: boolean;
  planned_at: string | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  sales_order: { id: string; order_number: string; customer: { name: string; phone: string | null } | null } | null;
  assigned_actor: { full_name: string } | null;
}

interface EventRow {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  is_ai_decision: boolean;
  reason: string | null;
  created_at: string;
  actor: { full_name: string } | null;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const EVENT_LABEL: Record<string, string> = {
  planning_started: "Perencanaan dimulai",
  ai_decision: "Keputusan AI",
  human_override: "Override manusia",
  human_reviewed: "Diterima manusia",
  ready_for_delivery: "Ditandai siap kirim",
};

export default async function DispatchPlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "dispatch.view")) redirect("/dashboard");
  const canManage = hasPermission(user.permissions, "dispatch.manage");

  const supabase = await createClient();

  const { data: planData } = await supabase
    .from("dispatch_plans")
    .select(
      "id, planning_status, delivery_date, delivery_area, delivery_group_key, assigned_actor_id, planning_reason, confidence_score, is_override, planned_at, scheduled_at, created_at, updated_at, " +
        "sales_order:sales_orders!sales_order_id(id, order_number, customer:customers!customer_id(name, phone)), " +
        "assigned_actor:users!assigned_actor_id(full_name)"
    )
    .eq("company_id", user.company_id)
    .eq("id", id)
    .maybeSingle();

  if (!planData) notFound();
  const plan = planData as unknown as PlanDetailRow;

  const { data: eventsData } = await supabase
    .from("dispatch_plan_events")
    .select("id, event_type, from_status, to_status, is_ai_decision, reason, created_at, actor:users!actor_id(full_name)")
    .eq("company_id", user.company_id)
    .eq("dispatch_plan_id", id)
    .order("created_at", { ascending: false });

  const events = ((eventsData ?? []) as unknown as EventRow[]);
  const salesmen = canManage ? await listSalesmenAction() : [];
  // Sudah direview TIDAK hanya dari is_override -- accept ("Terima Rekomendasi
  // AI") sengaja tidak mengubah is_override, hanya mencatat event
  // human_reviewed. Satu sumber kebenaran: computeHasHumanReview (workflow.ts).
  const hasHumanReview = computeHasHumanReview(
    { isOverride: plan.is_override },
    events.map((e) => ({ eventType: e.event_type }))
  );
  const canAccept = canManage && !hasHumanReview && ACCEPTABLE_FOR_REVIEW.includes(plan.planning_status);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Link href="/dashboard/dispatch" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke AI Dispatch Planner
        </Link>
      </div>

      <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-900">{plan.sales_order?.order_number ?? "—"}</h1>
              <DispatchStatusBadge status={plan.planning_status} />
            </div>
            <p className="text-sm text-gray-600 mt-0.5">{plan.sales_order?.customer?.name ?? "—"}</p>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {plan.is_override ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-700">
                <UserCog className="h-3.5 w-3.5" /> Sudah diubah manusia
              </span>
            ) : hasHumanReview ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> Diterima manusia
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-1 font-medium text-blue-700">
                <Sparkles className="h-3.5 w-3.5" /> Rekomendasi AI (belum direview)
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Tgl. Kirim</p>
            <p className="text-gray-800">{plan.delivery_date ? new Date(plan.delivery_date).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Area / Grup</p>
            <p className="text-gray-800">{plan.delivery_group_key ?? plan.delivery_area ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Salesman</p>
            <p className="text-gray-800">{plan.assigned_actor?.full_name ?? "Belum ditugaskan"}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-0.5">Confidence</p>
            <p className="text-gray-800">{(plan.confidence_score * 100).toFixed(0)}%</p>
          </div>
        </div>

        <div className="rounded-lg bg-gray-50 border border-gray-100 p-3">
          <p className="text-xs font-medium text-gray-500 mb-1">Alasan / Keputusan</p>
          <p className="text-sm text-gray-700">{plan.planning_reason || "—"}</p>
        </div>
      </div>

      {canManage && (
        <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Route className="h-4 w-4 text-gray-400" /> Tindakan
          </h2>
          <AssignSalesmanForm planId={plan.id} salesmen={salesmen} currentSalesmanId={plan.assigned_actor_id} />
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
            {canAccept && <AcceptPlanButton planId={plan.id} />}
            <HoldPlanForm planId={plan.id} />
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3">
          <Clock className="h-4 w-4 text-gray-400" /> Riwayat Keputusan
        </h2>
        {events.length === 0 ? (
          <p className="text-xs text-gray-400">Belum ada riwayat.</p>
        ) : (
          <ul className="space-y-2.5">
            {events.map((ev) => (
              <li key={ev.id} className="text-xs border-l-2 border-gray-100 pl-3">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`font-medium ${ev.is_ai_decision ? "text-blue-700" : "text-amber-700"}`}>
                    {ev.is_ai_decision ? "AI" : "Manusia"}
                  </span>
                  <span className="text-gray-700">{EVENT_LABEL[ev.event_type] ?? ev.event_type}</span>
                  {ev.to_status && <span className="text-gray-400">→ {ev.to_status}</span>}
                  {ev.actor?.full_name && <span className="text-gray-400">oleh {ev.actor.full_name}</span>}
                </div>
                {ev.reason && <p className="text-gray-500 mt-0.5">{ev.reason}</p>}
                <p className="text-gray-400 mt-0.5">{formatDateTime(ev.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
