"use server";

// =============================================================================
// Server actions — AI Dispatch Planner. Tenant SELALU dari sesi
// (getAuthUser()), tidak pernah dari input form — pola sama seperti
// lib/delivery/actions.ts.
//
// Authorization: hasPermission(user.permissions, "dispatch.manage") —
// permission ini SUDAH ADA (migration 20260721000001), diseed ke
// owner/manager/admin/super_admin. Tidak ada permission baru dibuat di sini
// (Human Review & Operational Control Gate).
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { SupabaseDispatchRepository } from "./repository";
import {
  runDispatchPlanning,
  overrideDispatchPlan,
  assignSalesman,
  acceptDispatchPlan,
  markPlanReadyForDelivery,
} from "./workflow";
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
  revalidatePath("/dashboard/dispatch");
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
  if (!hasPermission(user.permissions, "dispatch.manage")) {
    return { ok: false, error: "Tidak berwenang melakukan override dispatch plan." };
  }
  if (!planId) return { ok: false, error: "Dispatch plan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await overrideDispatchPlan(user.company_id, planId, { ...input, actorId: user.id }, { repository });

  if (result.outcome === "plan_not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "invalid_input") return { ok: false, error: result.error };
  if (result.outcome === "invalid_actor") return { ok: false, error: result.error };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  revalidatePath(`/dashboard/dispatch/${result.plan.id}`);
  revalidatePath("/dashboard/dispatch");
  return { ok: true, planId: result.plan.id };
}

/**
 * Tetapkan/ganti Salesman — wrapper tipis di atas assignSalesman()
 * (lib/dispatch/workflow.ts): idempotency, alasan kondisional, verifikasi
 * tenant+role Salesman, dan audit event semuanya ada di sana (testable
 * tanpa Next.js runtime). Di sini hanya authorization + tenant derivation.
 */
export async function assignSalesmanAction(
  planId: string,
  salesmanId: string,
  reason?: string
): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "dispatch.manage")) {
    return { ok: false, error: "Tidak berwenang menetapkan Salesman." };
  }
  if (!planId || !salesmanId) return { ok: false, error: "Dispatch plan dan Salesman wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await assignSalesman(user.company_id, planId, salesmanId, user.id, reason, { repository });

  if (result.outcome === "plan_not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "invalid_input") return { ok: false, error: result.error };
  if (result.outcome === "invalid_actor") return { ok: false, error: result.error };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  revalidatePath(`/dashboard/dispatch/${result.plan.id}`);
  revalidatePath("/dashboard/dispatch");
  return { ok: true, planId: result.plan.id };
}

/**
 * "Terima Rekomendasi AI" — hanya berlaku untuk plan yang masih murni
 * keputusan AI (planned/scheduled/ready_for_delivery), bukan status
 * conflict. Tidak mengubah data plan, hanya mencatat event review.
 */
export async function acceptDispatchPlanAction(planId: string): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "dispatch.manage")) {
    return { ok: false, error: "Tidak berwenang mereview dispatch plan." };
  }
  if (!planId) return { ok: false, error: "Dispatch plan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await acceptDispatchPlan(user.company_id, planId, user.id, { repository });
  if (result.outcome === "plan_not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "not_acceptable") return { ok: false, error: result.error };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  revalidatePath(`/dashboard/dispatch/${result.plan.id}`);
  revalidatePath("/dashboard/dispatch");
  return { ok: true, planId: result.plan.id };
}

export async function markReadyForDeliveryAction(planId: string): Promise<DispatchActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "dispatch.manage")) {
    return { ok: false, error: "Tidak berwenang mengubah status dispatch plan." };
  }
  if (!planId) return { ok: false, error: "Dispatch plan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);

  const result = await markPlanReadyForDelivery(user.company_id, planId, user.id, { repository });
  if (result.outcome === "not_found") return { ok: false, error: "Dispatch plan tidak ditemukan." };
  if (result.outcome === "not_scheduled") return { ok: false, error: "Dispatch plan belum berstatus scheduled." };

  revalidatePath(`/dashboard/orders/${result.plan.salesOrderId}`);
  revalidatePath(`/dashboard/dispatch/${result.plan.id}`);
  revalidatePath("/dashboard/dispatch");
  return { ok: true, planId: result.plan.id };
}

/** Daftar Salesman untuk company milik user yang sedang login — dipakai UI selector. Tenant SELALU dari sesi. */
export async function listSalesmenAction(): Promise<{ id: string; fullName: string }[]> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "dispatch.view")) return [];

  const supabase = getAdminClient();
  const repository = new SupabaseDispatchRepository(supabase);
  return repository.findSalesmenByCompany(user.company_id);
}
