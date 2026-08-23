"use server";

// =============================================================================
// Gate P4.16-B -- Server action wrapper untuk RPC submit_store_unlock_
// request_atomic/decide_store_unlock_request_atomic (Gate P4.16-B, LOCKED).
// Tidak ada RPC/tabel baru di sini -- murni boundary UI Sales/Owner -> RPC.
//
// PENTING: kedua RPC HANYA di-GRANT ke `authenticated` (service_role di-
// REVOKE eksplisit) -- identitas (auth.uid()) & tenant HARUS resolve dari
// sesi login, bukan parameter trusted. Pemanggilan WAJIB lewat createClient()
// session-scoped (@/lib/supabase/server), pola identik special-price-
// proposal-actions.ts.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { processAutomationEvent } from "@/lib/automation/engine";

export interface SubmitStoreUnlockRequestInput {
  customerId: string;
  reason: string;
  idempotencyKey: string;
}

export interface SubmitStoreUnlockRequestResult {
  outcome: "submitted" | "already_exists";
  requestId: string | null;
}

type SubmitRpcRow = {
  result_outcome: string;
  request_id: string | null;
  customer_id: string | null;
};

export async function submitStoreUnlockRequestAction(
  input: SubmitStoreUnlockRequestInput
): Promise<SubmitStoreUnlockRequestResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, "sales")) {
    throw new Error("Hanya Sales yang dapat mengajukan buka kunci toko.");
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("Alasan pengajuan wajib diisi.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_store_unlock_request_atomic", {
    p_customer_id: input.customerId,
    p_reason: reason,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw new Error(error.message);
  const row = ((data ?? []) as SubmitRpcRow[])[0];
  if (!row) throw new Error("submit_store_unlock_request_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "submitted":
    case "already_exists":
      break;
    case "unauthenticated":
      throw new Error("Sesi login tidak valid, silakan login ulang.");
    case "forbidden":
      throw new Error("Anda tidak berwenang mengajukan buka kunci toko.");
    case "not_found":
      throw new Error("Toko tidak ditemukan.");
    case "idempotency_conflict":
      throw new Error("Permintaan sebelumnya masih diproses dengan data berbeda -- muat ulang halaman dan coba lagi.");
    case "not_locked":
      throw new Error("Toko ini tidak sedang terkunci -- tidak perlu mengajukan buka kunci.");
    case "reason_required":
      throw new Error("Alasan pengajuan wajib diisi.");
    default:
      throw new Error(`Gagal mengajukan buka kunci toko: ${row.result_outcome}`);
  }

  revalidatePath(`/dashboard/customers/${input.customerId}`);
  revalidatePath("/dashboard/customers/unlock-requests");

  // Notifikasi realtime Owner lewat automation engine existing (pola identik
  // special-price-proposal-actions.ts) -- kegagalan di sini ditelan sengaja,
  // pengajuan sudah tersimpan sukses di DB sebelum titik ini.
  if (row.result_outcome === "submitted" && row.request_id) {
    try {
      const { data: customerRow } = await supabase
        .from("customers")
        .select("name")
        .eq("id", input.customerId)
        .maybeSingle();
      const customer = customerRow as { name: string } | null;

      await processAutomationEvent({
        trigger_type: "store_unlock_requested",
        company_id: user.company_id,
        data: {
          request_id: row.request_id,
          customer_id: input.customerId,
          customer_name: customer?.name ?? "-",
          requested_by_email: user.email,
          reason,
          review_link: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/customers/unlock-requests`,
        },
        fired_at: new Date().toISOString(),
      });
    } catch (notifyErr) {
      console.error("[store-unlock-request] gagal memicu notifikasi automation (diabaikan):", notifyErr);
    }
  }

  return {
    outcome: row.result_outcome as SubmitStoreUnlockRequestResult["outcome"],
    requestId: row.request_id,
  };
}

// =============================================================================
// Owner Unlock Inbox -- daftar pengajuan buka-kunci toko PENDING (tenant-
// wide), dan aksi keputusan Owner (approve/reject) lewat RPC Gate P4.16-B.
// =============================================================================

export interface PendingStoreUnlockRequestItem {
  requestId: string;
  customerId: string;
  customerName: string;
  requestedByName: string;
  reason: string | null;
  requestedAt: string;
}

export async function getPendingStoreUnlockRequests(
  companyId: string
): Promise<PendingStoreUnlockRequestItem[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("store_unlock_requests")
    .select("id, customer_id, reason, requested_at, requested_by, customers(name)")
    .eq("company_id", companyId)
    .eq("status", "PENDING")
    .order("requested_at", { ascending: true });

  if (error) throw new Error(`pending_store_unlock_requests: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    customer_id: string;
    reason: string | null;
    requested_at: string;
    requested_by: string;
    customers: { name: string } | null;
  }>;

  const requesterIds = [...new Set(rows.map((r) => r.requested_by))];
  const { data: requesterRows, error: requesterErr } = requesterIds.length
    ? await supabase.from("users").select("id, full_name").in("id", requesterIds)
    : { data: [], error: null };
  if (requesterErr) throw new Error(`pending_store_unlock_requests requesters: ${requesterErr.message}`);
  const nameMap = new Map(((requesterRows ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));

  return rows.map((row) => ({
    requestId: row.id,
    customerId: row.customer_id,
    customerName: row.customers?.name ?? "-",
    requestedByName: nameMap.get(row.requested_by) ?? "-",
    reason: row.reason,
    requestedAt: row.requested_at,
  }));
}

export interface DecideStoreUnlockRequestInput {
  requestId: string;
  customerId: string;
  decision: "APPROVED" | "REJECTED";
  idempotencyKey: string;
  decisionReason?: string;
}

export interface DecideStoreUnlockRequestResult {
  requestId: string;
  decision: string;
}

type DecideRpcRow = {
  result_outcome: string;
  request_id: string | null;
  decision: string | null;
  customer_id: string | null;
  decided_at: string | null;
};

export async function decideStoreUnlockRequestAction(
  input: DecideStoreUnlockRequestInput
): Promise<DecideStoreUnlockRequestResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, "owner")) {
    throw new Error("Hanya Owner yang dapat memutuskan pengajuan buka kunci toko.");
  }

  const decisionReason = input.decisionReason?.trim() || undefined;
  if (input.decision === "REJECTED" && !decisionReason) {
    throw new Error("Alasan penolakan wajib diisi.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_store_unlock_request_atomic", {
    p_request_id: input.requestId,
    p_decision: input.decision === "APPROVED" ? "APPROVE" : "REJECT",
    p_idempotency_key: input.idempotencyKey,
    p_decision_reason: decisionReason ?? null,
  });

  if (error) throw new Error(error.message);
  const row = ((data ?? []) as DecideRpcRow[])[0];
  if (!row) throw new Error("decide_store_unlock_request_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "approved":
    case "rejected":
      break;
    case "unauthenticated":
      throw new Error("Sesi login tidak valid, silakan login ulang.");
    case "forbidden":
      throw new Error("Hanya Owner yang dapat memutuskan pengajuan buka kunci toko.");
    case "not_found":
      throw new Error("Pengajuan tidak ditemukan.");
    case "invalid_decision":
      throw new Error("Keputusan tidak valid.");
    case "invalid_idempotency_key":
      throw new Error("Permintaan tidak valid -- muat ulang halaman dan coba lagi.");
    case "reason_required":
      throw new Error("Alasan penolakan wajib diisi.");
    case "idempotency_conflict":
      throw new Error("Permintaan sebelumnya masih diproses dengan data berbeda -- muat ulang halaman dan coba lagi.");
    case "already_decided":
      throw new Error("Pengajuan ini sudah diputuskan sebelumnya -- muat ulang halaman untuk melihat status terbaru.");
    default:
      throw new Error(`Gagal memutuskan pengajuan buka kunci toko: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/customers/unlock-requests");
  revalidatePath(`/dashboard/customers/${input.customerId}`);

  return {
    requestId: row.request_id ?? input.requestId,
    decision: row.decision ?? input.decision,
  };
}
