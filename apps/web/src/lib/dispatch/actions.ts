"use server";

// =============================================================================
// Server actions — AI Dispatch Planner. Tenant SELALU dari sesi
// (getAuthUser()), tidak pernah dari input form — pola sama seperti
// lib/delivery/actions.ts.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { SupabaseDispatchRepository } from "./repository";
import { runDispatchPlanning, overrideDispatchPlan, markPlanReadyForDelivery } from "./workflow";
import type { OverrideAction } from "./types";

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

export interface DispatchActionResult {
  ok: boolean;
  error?: string;
  planId?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function createDispatchPlanAction(salesOrderId: string): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!MANAGE_ROLES.some((r) => user.roles.includes(r)) && !user.roles.includes("sales")) {
    return { ok: false, error: "Tidak berwenang membuat dispatch plan." };
  }
  if (!salesOrderId) return { ok: false, error: "Sales order wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const { data: order } = await supabase
    .from("sales_orders")
    .select("id, status")
    .eq("id", salesOrderId)
    .eq("company_id", user.company_id)
    .maybeSingle();
  if (!order) return { ok: false, error: "Order tidak ditemukan." };
  if (order.status !== "confirmed") {
    return { ok: false, error: "Order harus berstatus confirmed sebelum dispatch plan dapat dibuat." };
  }

  const result = await runDispatchPlanning(user.company_id, salesOrderId, user.id, todayIso(), { repository });
  if (result.outcome === "order_not_found") return { ok: false, error: "Data order tidak lengkap untuk perencanaan." };

  revalidatePath(`/dashboard/orders/${salesOrderId}`);
  return { ok: true, planId: result.plan.id };
}

export interface OverrideDispatchInput {
  action: OverrideAction;
  reason: string;
  deliveryDate?: string;
  deliveryArea?: string;
  assignedActorId?: string | null;
}

export async function overrideDispatchPlanAction(planId: string, input: OverrideDispatchInput): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!MANAGE_ROLES.some((r) => user.roles.includes(r))) {
    return { ok: false, error: "Tidak berwenang melakukan override dispatch plan." };
  }
  if (!planId) return { ok: false, error: "Dispatch plan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await overrideDispatchPlan(
    user.company_id,
    planId,
    { ...input, actorId: user.id },
    { repository }
  );

  if (result.outcome === "plan_not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "invalid_input") return { ok: false, error: result.error };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  return { ok: true, planId: result.plan.id };
}

export async function markReadyForDeliveryAction(planId: string): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!MANAGE_ROLES.some((r) => user.roles.includes(r))) {
    return { ok: false, error: "Tidak berwenang mengubah status dispatch plan." };
  }
  if (!planId) return { ok: false, error: "Dispatch plan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await markPlanReadyForDelivery(user.company_id, planId, user.id, { repository });
  if (result.outcome === "not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "not_scheduled") return { ok: false, error: "Dispatch plan belum berstatus scheduled." };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  return { ok: true, planId: result.plan.id };
}
