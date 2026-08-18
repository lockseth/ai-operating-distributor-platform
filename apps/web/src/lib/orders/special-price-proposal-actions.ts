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
import type { SupabaseClient } from "@supabase/supabase-js";
import { processAutomationEvent } from "@/lib/automation/engine";

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

  // Notifikasi realtime Owner Approval Inbox -- fire-and-forget lewat
  // automation engine existing (event -> rule -> call_n8n -> webhook
  // terkonfigurasi per tenant, lib/automation/engine.ts, TIDAK diubah).
  // Provider WhatsApp aktual (Bablast) belum dikoneksikan di sisi n8n --
  // event ini akan no-op (skipped, "Tidak ada webhook terdaftar") sampai
  // rule+webhook didaftarkan, TIDAK memblokir alur pengajuan sama sekali.
  // Kegagalan apa pun di sini sengaja ditelan -- pengajuan harga khusus
  // sudah tersimpan sukses di DB sebelum titik ini, notifikasi best-effort
  // tidak boleh menggagalkan aksi bisnis yang sudah berhasil.
  if (row.result_outcome === "submitted" && row.approval_request_id) {
    try {
      const { data: orderRow } = await supabase
        .from("sales_orders")
        .select("order_number, customers(name)")
        .eq("id", input.orderId)
        .maybeSingle();
      const order = orderRow as { order_number: string; customers: { name: string } | null } | null;

      await processAutomationEvent({
        trigger_type: "special_price_proposal_submitted",
        company_id: user.company_id,
        data: {
          approval_request_id: row.approval_request_id,
          order_id: input.orderId,
          order_number: order?.order_number ?? "-",
          customer_name: order?.customers?.name ?? "-",
          requested_by_email: user.email,
          reason,
          proposal_version: row.proposal_version,
          item_count: input.items.length,
          approval_link: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/orders/approvals`,
        },
        fired_at: new Date().toISOString(),
      });
    } catch (notifyErr) {
      console.error("[special-price-proposal] gagal memicu notifikasi automation (diabaikan):", notifyErr);
    }
  }

  return {
    outcome: row.result_outcome as SubmitSpecialPriceProposalResult["outcome"],
    requiresApproval: row.requires_approval ?? false,
    approvalRequestId: row.approval_request_id,
    proposalVersion: row.proposal_version,
    orderStatus: row.order_status,
  };
}

// =============================================================================
// Owner Approval Inbox -- daftar semua permintaan harga khusus PENDING
// lintas order (tenant-wide), dan aksi keputusan Owner (approve/reject) lewat
// RPC existing (Gate 3E-D4-C3, LOCKED) decide_special_price_proposal_atomic.
//
// RPC ini juga hanya di-GRANT ke `authenticated` (bukan service_role) --
// createClient() session-scoped wajib dipakai, sama seperti submit action di
// atas. Decider harus role='owner' murni (dicek RAW di dalam RPC, bukan lewat
// permission table) -- guard role di sini murni defense-in-depth app-layer.
// =============================================================================

export interface PendingSpecialPriceProposalItem {
  approvalRequestId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  requestedByName: string;
  proposalVersion: number;
  reason: string | null;
  requestedAt: string;
  lines: {
    productName: string;
    quantity: number;
    masterUnitPrice: number;
    proposedUnitPrice: number;
    impliedDiscountPercentage: number;
  }[];
}

export async function getPendingSpecialPriceProposals(
  companyId: string,
  client?: SupabaseClient
): Promise<PendingSpecialPriceProposalItem[]> {
  const supabase = client ?? (await createClient());

  const { data, error } = await supabase
    .from("special_price_approval_requests")
    .select(
      "id, proposal_version, reason, requested_at, requested_by, sales_orders(id, order_number, customers(name)), special_price_approval_lines(product_name_snapshot, quantity, master_unit_price, proposed_unit_price, implied_discount_percentage, line_number)"
    )
    .eq("company_id", companyId)
    .eq("status", "PENDING")
    .order("requested_at", { ascending: true });

  if (error) throw new Error(`pending_special_price_proposals: ${error.message}`);

  const rows = (data ?? []) as unknown as Array<{
    id: string;
    proposal_version: number;
    reason: string | null;
    requested_at: string;
    requested_by: string;
    sales_orders: { id: string; order_number: string; customers: { name: string } | null } | null;
    special_price_approval_lines: {
      product_name_snapshot: string;
      quantity: number;
      master_unit_price: number;
      proposed_unit_price: number;
      implied_discount_percentage: number;
      line_number: number;
    }[];
  }>;

  const requesterIds = [...new Set(rows.map((r) => r.requested_by))];
  const { data: requesterRows, error: requesterErr } = requesterIds.length
    ? await supabase.from("users").select("id, full_name").in("id", requesterIds)
    : { data: [], error: null };
  if (requesterErr) throw new Error(`pending_special_price_proposals requesters: ${requesterErr.message}`);
  const nameMap = new Map(((requesterRows ?? []) as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name]));

  return rows.map((row) => ({
    approvalRequestId: row.id,
    orderId: row.sales_orders?.id ?? "",
    orderNumber: row.sales_orders?.order_number ?? "-",
    customerName: row.sales_orders?.customers?.name ?? "-",
    requestedByName: nameMap.get(row.requested_by) ?? "-",
    proposalVersion: row.proposal_version,
    reason: row.reason,
    requestedAt: row.requested_at,
    lines: [...row.special_price_approval_lines]
      .sort((a, b) => a.line_number - b.line_number)
      .map((line) => ({
        productName: line.product_name_snapshot,
        quantity: line.quantity,
        masterUnitPrice: line.master_unit_price,
        proposedUnitPrice: line.proposed_unit_price,
        impliedDiscountPercentage: line.implied_discount_percentage,
      })),
  }));
}

export interface DecideSpecialPriceProposalInput {
  approvalRequestId: string;
  orderId: string;
  decision: "APPROVED" | "REJECTED";
  idempotencyKey: string;
  decisionReason?: string;
}

export interface DecideSpecialPriceProposalResult {
  approvalRequestId: string;
  decision: string;
  proposalVersion: number;
  orderStatus: string | null;
}

type DecideRpcRow = {
  result_outcome: string;
  approval_request_id: string | null;
  decision: string | null;
  proposal_version: number | null;
  order_status: string | null;
  decided_at: string | null;
};

export async function decideSpecialPriceProposalAction(
  input: DecideSpecialPriceProposalInput
): Promise<DecideSpecialPriceProposalResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, "owner")) {
    throw new Error("Hanya Owner yang dapat memutuskan permintaan harga khusus.");
  }

  const decisionReason = input.decisionReason?.trim() || undefined;
  if (input.decision === "REJECTED" && !decisionReason) {
    throw new Error("Alasan penolakan wajib diisi.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_special_price_proposal_atomic", {
    p_approval_request_id: input.approvalRequestId,
    // RPC menerima verb 'APPROVE'/'REJECT' (bukan 'APPROVED'/'REJECTED' --
    // itu nilai kolom `decision` hasil, lihat migration 20260925000001:609-613).
    p_decision: input.decision === "APPROVED" ? "APPROVE" : "REJECT",
    p_idempotency_key: input.idempotencyKey,
    p_decision_reason: decisionReason ?? null,
  });

  if (error) throw new Error(error.message);
  const row = ((data ?? []) as DecideRpcRow[])[0];
  if (!row) throw new Error("decide_special_price_proposal_atomic: empty RPC result");

  switch (row.result_outcome) {
    case "approved":
    case "rejected":
      break;
    case "unauthenticated":
      throw new Error("Sesi login tidak valid, silakan login ulang.");
    case "forbidden":
      throw new Error("Hanya Owner yang dapat memutuskan permintaan harga khusus.");
    case "not_found":
      throw new Error("Permintaan harga khusus tidak ditemukan.");
    case "invalid_decision":
      throw new Error("Keputusan tidak valid.");
    case "invalid_idempotency_key":
      throw new Error("Permintaan tidak valid -- muat ulang halaman dan coba lagi.");
    case "reason_required":
      throw new Error("Alasan penolakan wajib diisi.");
    case "idempotency_conflict":
      throw new Error("Permintaan sebelumnya masih diproses dengan data berbeda -- muat ulang halaman dan coba lagi.");
    case "already_decided":
      throw new Error("Permintaan ini sudah diputuskan sebelumnya -- muat ulang halaman untuk melihat status terbaru.");
    case "invalid_order_state":
      throw new Error("Order sudah berubah status -- muat ulang halaman untuk melihat status terbaru.");
    case "snapshot_mismatch":
      throw new Error("Data order sudah berubah sejak permintaan diajukan -- muat ulang halaman untuk melihat detail terbaru.");
    default:
      throw new Error(`Gagal memutuskan permintaan harga khusus: ${row.result_outcome}`);
  }

  revalidatePath("/dashboard/orders/approvals");
  revalidatePath(`/dashboard/orders/${input.orderId}`);

  return {
    approvalRequestId: row.approval_request_id ?? input.approvalRequestId,
    decision: row.decision ?? input.decision,
    proposalVersion: row.proposal_version ?? 0,
    orderStatus: row.order_status,
  };
}
