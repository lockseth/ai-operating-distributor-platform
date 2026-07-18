"use server";

// =============================================================================
// Server actions — Human Review untuk Order Cancellation & Dispute.
// Tenant & reviewer SELALU dari sesi (getAuthUser()), tidak pernah dari input
// form -- pola sama seperti lib/dispatch/actions.ts.
//
// Authorization: hasPermission(user.permissions, "orders.cancellation_review")
// -- permission ini SUDAH ADA (migration 20260725000001), diseed ke
// owner/manager/admin/super_admin. Salesman TIDAK memiliki permission ini,
// dan RPC resolve_order_cancellation_dispute juga menolak self-review secara
// independen (defense in depth) -- lihat lib/order-disputes/workflow.ts.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { SupabaseOrderDisputeRepository } from "./repository";
import type { Resolution } from "./types";

export interface ResolveDisputeActionResult {
  ok: boolean;
  error?: string;
}

export async function resolveDisputeRequestAction(
  requestId: string,
  salesOrderId: string,
  resolution: Resolution,
  resolutionNotes: string | null,
  actualPicName: string | null
): Promise<ResolveDisputeActionResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "orders.cancellation_review")) {
    return { ok: false, error: "Tidak berwenang mereview permintaan pembatalan/sengketa order." };
  }
  if (!requestId) return { ok: false, error: "Permintaan wajib dipilih." };

  const supabase = getAdminClient();
  const repository = new SupabaseOrderDisputeRepository(supabase);

  const result = await repository.resolveRequest({
    companyId: user.company_id,
    requestId,
    reviewerId: user.id,
    resolution,
    resolutionNotes,
    actualPicName,
  });

  if (result.outcome === "not_found") return { ok: false, error: "Permintaan tidak ditemukan." };
  if (result.outcome === "self_review_forbidden") {
    return { ok: false, error: "Anda tidak dapat mereview permintaan yang Anda ajukan sendiri." };
  }
  if (result.outcome === "already_resolved") return { ok: false, error: "Permintaan ini sudah diproses sebelumnya." };
  if (result.outcome === "forbidden") return { ok: false, error: "Anda tidak berwenang melakukan review ini." };
  if (result.outcome === "invalid_input") return { ok: false, error: "Data resolusi tidak valid." };
  if (result.outcome === "unexpected_error") return { ok: false, error: result.error };

  revalidatePath(`/dashboard/orders/${salesOrderId}`);
  return { ok: true };
}
