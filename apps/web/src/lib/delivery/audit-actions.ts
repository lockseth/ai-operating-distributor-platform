"use server";

// Audit acak pengiriman (Owner): buat sampel, catat hasil telepon ke toko.
// Aktor & tenant dari sesi; penulisan lewat admin client (RLS tanpa policy tulis).

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { logAuditEvent } from "@/lib/actions/audit";
import { INVOICE_APPROVER_ROLES } from "@/lib/finance/invoice-approval";
import { selectAuditSample, type AuditCandidate } from "./audit-sampling";

const AUDIT_ROLES = INVOICE_APPROVER_ROLES; // Owner / super_admin
const FORBIDDEN = { ok: false as const, error: "Hanya Owner yang dapat mengelola audit pengiriman." };
const LOOKBACK_DAYS = 7;
const MAX_SAMPLE = 20;

export interface AuditActionResult {
  ok: boolean;
  error?: string;
  created?: number;
}

export async function createDeliveryAuditSampleAction(count: number): Promise<AuditActionResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, AUDIT_ROLES)) return FORBIDDEN;
  const n = Math.min(MAX_SAMPLE, Math.max(1, Math.floor(Number(count) || 0)));

  const admin = getAdminClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: rows } = await admin
    .from("deliveries")
    .select("id, sales_order_id, status, evidence:delivery_evidence(evidence_type, metadata), items:delivery_items(dispatched_quantity, received_quantity)")
    .eq("company_id", user.company_id)
    .not("status", "in", "(planned,dispatched,arrived)")
    .gte("finalized_at", since);

  const deliveries = (rows ?? []) as unknown as {
    id: string; sales_order_id: string; status: string;
    evidence: { evidence_type: string; metadata: Record<string, unknown> | null }[];
    items: { dispatched_quantity: number; received_quantity: number }[];
  }[];

  const { data: already } = await admin.from("delivery_audits").select("delivery_id").eq("company_id", user.company_id);
  const done = new Set(((already ?? []) as { delivery_id: string }[]).map((a) => a.delivery_id));

  const byId = new Map(deliveries.map((d) => [d.id, d]));
  const candidates: AuditCandidate[] = deliveries
    .filter((d) => !done.has(d.id))
    .map((d) => ({
      deliveryId: d.id,
      inputByAdmin: d.evidence.some((e) => e.metadata?.source === "admin_input"),
      hasLocation: d.evidence.some((e) => e.evidence_type === "location"),
      hasVariance: d.items.some((i) => Number(i.dispatched_quantity) !== Number(i.received_quantity)),
    }));

  const picked = selectAuditSample(candidates, n);
  if (picked.length === 0) return { ok: false, error: "Tidak ada pengiriman selesai (7 hari terakhir) yang belum diaudit." };

  const { error } = await admin.from("delivery_audits").insert(
    picked.map((p) => ({
      company_id: user.company_id,
      delivery_id: p.deliveryId,
      sales_order_id: byId.get(p.deliveryId)!.sales_order_id,
      selection_reason: p.reason,
      selected_by: user.id,
    })),
  );
  if (error) return { ok: false, error: "Gagal membuat sampel audit." };

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id, action: "delivery_audit.sample",
    entity_type: "delivery_audits", new_data: { count: picked.length }, module: "delivery",
  }).catch(() => {});

  revalidatePath("/dashboard/deliveries/audits");
  return { ok: true, created: picked.length };
}

export async function recordDeliveryAuditResultAction(
  auditId: string,
  result: "verified_ok" | "discrepancy",
  note: string,
): Promise<AuditActionResult> {
  const user = await getAuthUser();
  if (!hasRole(user.roles, AUDIT_ROLES)) return FORBIDDEN;
  const trimmed = note.trim();
  if (result === "discrepancy" && trimmed.length < 3) return { ok: false, error: "Catatan wajib diisi bila hasil tidak sesuai." };

  const { data, error } = await getAdminClient()
    .from("delivery_audits")
    .update({ status: result, checked_by: user.id, checked_at: new Date().toISOString(), result_note: trimmed || null })
    .eq("id", auditId)
    .eq("company_id", user.company_id)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, error: "Gagal menyimpan hasil audit." };
  if (!(data ?? []).length) return { ok: false, error: "Audit tidak ditemukan atau sudah dicatat." };

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id, action: `delivery_audit.${result}`,
    entity_type: "delivery_audits", entity_id: auditId, new_data: { result, note: trimmed || null }, module: "delivery",
  }).catch(() => {});

  revalidatePath("/dashboard/deliveries/audits");
  return { ok: true };
}
