"use server";

// =============================================================================
// Gate 3E-D6-B -- Server action wrapper untuk RPC existing (Gate 3E-D4-C2/C3,
// LOCKED) submit_special_price_proposal_atomic. Tidak ada RPC/tabel/sistem
// approval baru di sini -- murni boundary UI Sales -> RPC.
//
// PENTING: RPC ini SENGAJA hanya di-GRANT ke `authenticated` dan
// service_role di-REVOKE eksplisit (migration 20260924000001) -- identitas
// (auth.uid()) & tenant HARUS resolve dari sesi login, bukan parameter
// trusted. Maka pemanggilan WAJIB lewat createClient() session-scoped
// (@/lib/supabase/server), BUKAN getAdminClient() seperti mayoritas action
// lain di lib/orders/actions.ts -- memakai admin client akan membuat
// auth.uid() NULL di dalam RPC dan selalu mengembalikan 'unauthenticated'.
// Pola ini identik provisioning/password-change (lihat
// apps/web/src/components/auth/signup-form.tsx, lib/auth/get-user.ts).
//
// Role & ownership (role 'sales' strict + order.sales_id === actor) sudah
// ditegakkan fail-closed di dalam RPC; guard role di sini murni
// defense-in-depth app-layer (pola identik updateOrderStatusAction di
// lib/orders/actions.ts) supaya reject terjadi SEBELUM RPC dipanggil sama
// sekali untuk role yang jelas tidak berwenang.
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export interface SubmitSpecialPriceProposalItemInput {
  salesOrderItemId: string;
  proposedUnitPrice: number;
}

export interface SubmitSpecialPriceProposalInput {
  orderId: string;
  items: SubmitSpecialPriceProposalItemInput[];
  reason: string;
  idempotencyKey: string;
}

export interface SubmitSpecialPriceProposalResult {
  outcome: "submitted" | "approval_not_required" | "already_exists";
  requiresApproval: boolean;
  approvalRequestId: string | null;
  proposalVersion: number | null;
  orderStatus: string | null;
}

type SubmitRpcRow = {
  result_outcome: string;
  requires_approval: boolean | null;
  approval_request_id: string | null;
  proposal_version: number | null;
  order_status: string | null;
};

export async function submitSpecialPriceProposalAction(
  input: SubmitSpecialPriceProposalInput
): Promise<SubmitSpecialPriceProposalResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, "sales")) {
    throw new Error("Hanya Sales yang dapat mengajukan harga khusus.");
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("Alasan pengajuan wajib diisi.");
  }
  if (input.items.length === 0) {
    throw new Error("Pilih minimal satu item untuk diajukan harga khususnya.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_special_price_proposal_atomic", {
    p_sales_order_id: input.orderId,
    p_items: input.items.map((item) => ({
      sales_order_item_id: item.salesOrderItemId,
      proposed_unit_price: item.proposedUnitPrice,
    })),
    p_reason: reason,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) throw new Error(error.message);
  const row = ((data ?? []) as SubmitRpcRow[])[0];
  if (!row) throw new Error("submit_special_price_proposal_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "submitted":
    case "approval_not_required":
    case "already_exists":
      break;
    case "unauthenticated":
      throw new Error("Sesi login tidak valid, silakan login ulang.");
    case "forbidden":
      throw new Error("Anda tidak berwenang mengajukan harga khusus untuk order ini.");
    case "not_found":
      throw new Error("Order tidak ditemukan.");
    case "idempotency_conflict":
      throw new Error("Permintaan sebelumnya masih diproses dengan data berbeda -- muat ulang halaman dan coba lagi.");
    case "not_draft":
      throw new Error("Hanya order berstatus Draft yang dapat diajukan harga khususnya -- muat ulang halaman untuk melihat status terbaru.");
    case "no_items":
      throw new Error("Pilih minimal satu item untuk diajukan harga khususnya.");
    case "invalid_payload":
      throw new Error("Data item yang diajukan tidak lengkap.");
    case "duplicate_line":
      throw new Error("Ada item yang dipilih lebih dari sekali.");
    case "line_not_found":
      throw new Error("Salah satu item tidak ditemukan pada order ini -- muat ulang halaman.");
    case "invalid_price":
      throw new Error("Harga yang diajukan tidak valid -- harus lebih dari 0 dan tidak melebihi harga master.");
    case "inactive_product":
      throw new Error("Salah satu produk pada item yang dipilih sudah tidak aktif.");
    case "reason_required":
      throw new Error("Alasan pengajuan wajib diisi.");
    default:
      throw new Error(`Gagal mengajukan harga khusus: ${row.result_outcome}`);
  }

  revalidatePath(`/dashboard/orders/${input.orderId}`);

  return {
    outcome: row.result_outcome as SubmitSpecialPriceProposalResult["outcome"],
    requiresApproval: row.requires_approval ?? false,
    approvalRequestId: row.approval_request_id,
    proposalVersion: row.proposal_version,
    orderStatus: row.order_status,
  };
}
