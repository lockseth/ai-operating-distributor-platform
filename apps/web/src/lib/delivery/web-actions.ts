"use server";

// =============================================================================
// Server action pengantar (web, tanpa Telegram) -- S1: Mulai Antar & Sudah
// Tiba; S2: unggah bukti + kirim hasil (mirror lib/delivery/workflow.ts). Tenant & aktor SELALU
// dari sesi (getAuthUser). Hanya pengantar yang ditugaskan yang boleh
// mengerjakan; RPC dispatch_delivery_atomic menegakkan hal yang sama di DB.
// Rancangan: docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { SupabaseDeliveryRepository } from "./repository";
import {
  buildArrivalLocationEvidence,
  buildItemOutcomes,
  canOperateDelivery,
  isEvidencePathForDelivery,
  isValidGeoFix,
  type GeoFix,
} from "./web-rules";
import {
  buildOwnerAlertPayload,
  computeExceptionSeverity,
  computeInvoiceEligibility,
  mapOutcomeToFinalStatus,
  requiresOwnerAlert,
  validateEvidence,
  validateReasonNote,
} from "./service";
import { REASON_CODES, type DeliveryOutcome, type EvidenceType, type ReasonCode } from "./types";

export interface DeliveryStepResult {
  ok: boolean;
  error?: string;
}

/**
 * asAdmin = jalur input kantor (Admin/Faktur memasukkan hasil dari faktur bertanda tangan,
 * alur nyata Waluyo). Butuh izin delivery.manage; tidak harus pengantar yang ditugaskan.
 * Rancangan: docs/product/delivery-verification/AODP_DELIVERY_ADMIN_INPUT_DESIGN.md
 */
async function loadOperableDelivery(deliveryId: string, asAdmin = false) {
  const user = await getAuthUser();
  const repository = new SupabaseDeliveryRepository(getAdminClient());
  const delivery = await repository.getDelivery(deliveryId);
  if (!delivery || delivery.companyId !== user.company_id) {
    return { error: "Pengiriman tidak ditemukan." as const };
  }
  if (asAdmin) {
    if (!hasPermission(user.permissions, "delivery.manage")) {
      return { error: "Tidak punya akses untuk menginput hasil pengiriman." as const };
    }
  } else if (!canOperateDelivery(user.id, delivery)) {
    return { error: "Pengiriman ini bukan tugas Anda." as const };
  }
  return { user, repository, delivery };
}

export async function startDeliveryAction(deliveryId: string): Promise<DeliveryStepResult> {
  const ctx = await loadOperableDelivery(deliveryId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, repository, delivery } = ctx;

  if (delivery.status !== "planned") return { ok: true }; // idempoten: sudah berjalan

  const result = await repository.dispatchDeliveryAtomic({
    companyId: user.company_id,
    actorId: user.id,
    deliveryId,
  });
  if (result.outcome === "forbidden" || result.outcome === "not_found") {
    return { ok: false, error: "Tidak bisa memulai pengiriman ini." };
  }
  await repository.syncSalesOrderStatus(delivery.salesOrderId);
  await repository.insertEvent({
    companyId: user.company_id,
    deliveryId,
    eventType: "dispatched",
    fromStatus: "planned",
    toStatus: "dispatched",
    actorId: user.id,
    telegramUpdateEventId: null,
    payload: { source: "web" },
  });

  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/deliveries/${deliveryId}`);
  revalidatePath(`/dashboard/orders/${delivery.salesOrderId}`);
  return { ok: true };
}

export async function arriveDeliveryAction(deliveryId: string, fix: GeoFix | null): Promise<DeliveryStepResult> {
  const ctx = await loadOperableDelivery(deliveryId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, repository, delivery } = ctx;

  if (delivery.status === "arrived") return { ok: true }; // idempoten
  if (delivery.status !== "dispatched") {
    return { ok: false, error: "Mulai antar dulu sebelum menandai sudah tiba." };
  }

  const { evidence, locationMissing } = buildArrivalLocationEvidence(fix, new Date().toISOString());

  await repository.recordArrival(deliveryId);
  if (evidence) await repository.insertEvidence(user.company_id, deliveryId, evidence, user.id);
  await repository.insertEvent({
    companyId: user.company_id,
    deliveryId,
    eventType: "arrived",
    fromStatus: "dispatched",
    toStatus: "arrived",
    actorId: user.id,
    telegramUpdateEventId: null,
    payload: { source: "web", locationMissing },
  });

  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/deliveries/${deliveryId}`);
  revalidatePath(`/dashboard/orders/${delivery.salesOrderId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// S2 -- unggah bukti (foto/tanda tangan) ke bucket privat delivery-evidence.
// Pola uploadPaymentProofAction: path SELALU dari sesi + delivery, bukan dari client.
// ---------------------------------------------------------------------------

const EVIDENCE_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
const ADMIN_INPUT_STATUSES: string[] = ["planned", "dispatched", "arrived"];
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // sinkron file_size_limit bucket

export interface UploadDeliveryEvidenceResult {
  ok: boolean;
  error?: string;
  path?: string;
}

export async function uploadDeliveryEvidenceAction(formData: FormData): Promise<UploadDeliveryEvidenceResult> {
  const deliveryId = String(formData.get("deliveryId") ?? "");
  const asAdmin = formData.get("asAdmin") === "1";
  const ctx = await loadOperableDelivery(deliveryId, asAdmin);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, delivery } = ctx;

  if (asAdmin ? !ADMIN_INPUT_STATUSES.includes(delivery.status) : delivery.status !== "arrived") {
    return { ok: false, error: asAdmin ? "Pengiriman ini sudah selesai." : "Tandai sudah tiba dulu sebelum mengunggah bukti." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "File tidak valid." };
  const ext = EVIDENCE_MIME[file.type];
  if (!ext) return { ok: false, error: "Format file harus JPEG, PNG, WebP, atau HEIC." };
  if (file.size > MAX_EVIDENCE_BYTES) return { ok: false, error: "Ukuran file maksimal 10MB." };

  const path = `${user.company_id}/${deliveryId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const { error } = await getAdminClient().storage.from("delivery-evidence").upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) return { ok: false, error: "Gagal mengunggah bukti." };
  return { ok: true, path };
}

// ---------------------------------------------------------------------------
// S2 -- kirim hasil pengiriman. Satu keputusan atomik lewat finalize_delivery_atomic
// (sama dengan jalur Telegram); validasi bukti memakai service.ts yang sama.
// ---------------------------------------------------------------------------

export interface SubmitDeliveryResultInput {
  deliveryId: string;
  outcome: DeliveryOutcome;
  /** Hanya untuk "partial": jumlah diterima per delivery_item. */
  receivedByItem?: Record<string, number>;
  reasonCode: ReasonCode | null;
  reasonNote: string | null;
  recipientName: string | null;
  photoPaths: string[];
  signaturePath: string | null;
  /** Lokasi saat mengirim hasil (dipakai bila saat tiba lokasi tidak tersedia, mis. toko tutup). */
  fix: GeoFix | null;
  /** Jalur input admin dari faktur bertanda tangan (foto faktur wajib, tanda tangan layar tidak). */
  asAdmin?: boolean;
}

const VALID_OUTCOMES: DeliveryOutcome[] = ["full", "partial", "rejected", "store_closed", "failed"];

export async function submitDeliveryResultAction(input: SubmitDeliveryResultInput): Promise<DeliveryStepResult> {
  const asAdmin = input.asAdmin === true;
  const source = asAdmin ? "admin_input" : "web";
  const ctx = await loadOperableDelivery(input.deliveryId, asAdmin);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { user, repository, delivery } = ctx;

  if (!VALID_OUTCOMES.includes(input.outcome)) return { ok: false, error: "Hasil pengiriman tidak valid." };
  if (!ADMIN_INPUT_STATUSES.includes(delivery.status)) return { ok: true }; // sudah final (idempoten)
  if (!asAdmin && delivery.status !== "arrived") {
    return { ok: false, error: "Tandai sudah tiba dulu sebelum mengirim hasil." };
  }

  const outcome = input.outcome;
  const reasonCode: ReasonCode | null = outcome === "store_closed" ? "STORE_CLOSED" : input.reasonCode;
  if (reasonCode && !REASON_CODES.includes(reasonCode)) return { ok: false, error: "Alasan tidak valid." };
  const reasonNote = input.reasonNote?.trim() ? input.reasonNote.trim() : null;
  if (reasonCode && !validateReasonNote(reasonCode, reasonNote)) return { ok: false, error: "Alasan Lainnya wajib diberi catatan." };

  const itemsBuilt = buildItemOutcomes(
    outcome,
    delivery.items.map((i) => ({ id: i.id, dispatchedQuantity: i.dispatchedQuantity })),
    input.receivedByItem ?? {},
  );
  if (!itemsBuilt.ok) return { ok: false, error: itemsBuilt.error };

  for (const p of [...input.photoPaths, ...(input.signaturePath ? [input.signaturePath] : [])]) {
    if (!isEvidencePathForDelivery(p, user.company_id, delivery.id)) return { ok: false, error: "Bukti tidak valid." };
  }

  const recipientName = input.recipientName?.trim() ? input.recipientName.trim() : null;
  const hasLocation = delivery.evidence.some((e) => e.evidenceType === "location") || isValidGeoFix(input.fix);
  const evidenceTypes: EvidenceType[] = [];
  if (input.photoPaths.length > 0) evidenceTypes.push("photo");
  if (input.signaturePath) evidenceTypes.push("signature");
  // Jalur admin: tanda tangan toko ada di faktur kertas (difoto), bukan di layar -- foto faktur wajib untuk SEMUA hasil.
  if (asAdmin) {
    if (input.photoPaths.length === 0) return { ok: false, error: "Belum lengkap: foto faktur bertanda tangan." };
    if (!evidenceTypes.includes("signature")) evidenceTypes.push("signature");
  }

  const check = validateEvidence({ outcome, evidenceTypes, hasRecipient: !!recipientName, hasLocation: hasLocation || asAdmin, reasonCode });
  if (!check.valid) {
    const label: Record<string, string> = { photo: "foto", signature: "tanda tangan", recipient: "nama penerima", reason_code: "alasan", location: "lokasi" };
    return { ok: false, error: `Belum lengkap: ${check.missing.map((m) => label[m] ?? m).join(", ")}.` };
  }

  // Bukti: lokasi susulan (bila saat tiba tidak ada), foto, tanda tangan. Append-only.
  if (!delivery.evidence.some((e) => e.evidenceType === "location") && isValidGeoFix(input.fix)) {
    const { evidence } = buildArrivalLocationEvidence(input.fix, new Date().toISOString());
    if (evidence) await repository.insertEvidence(user.company_id, delivery.id, { ...evidence, metadata: { ...evidence.metadata, step: "result" } }, user.id);
  }
  const fixFields = isValidGeoFix(input.fix) ? { latitude: input.fix.latitude, longitude: input.fix.longitude } : {};
  for (const path of input.photoPaths) {
    await repository.insertEvidence(user.company_id, delivery.id, { evidenceType: "photo", storageRef: path, metadata: { source }, ...fixFields }, user.id);
  }
  if (input.signaturePath) {
    await repository.insertEvidence(user.company_id, delivery.id, { evidenceType: "signature", storageRef: input.signaturePath, metadata: { source } }, user.id);
  }

  // Severity & penerima (DV-05) -- sama persis dengan handleFinalConfirmation.
  const previewItems = delivery.items.map((item) => ({ ...item, receivedQuantity: itemsBuilt.outcomes[item.id].receivedQuantity }));
  const eligibilityForSeverity = computeInvoiceEligibility({ ...delivery, items: previewItems });
  const severity = reasonCode ? computeExceptionSeverity(outcome, eligibilityForSeverity) : null;

  let previousRecipient: string | null = null;
  let isExpectedPic: boolean | null = null;
  const requiresRecipient = outcome === "full" || outcome === "partial";
  if (requiresRecipient && recipientName) {
    previousRecipient = await repository.getPreviousRecipientName(delivery.salesOrderId, delivery.attemptNumber);
    isExpectedPic = previousRecipient === null || previousRecipient.trim().toLowerCase() === recipientName.toLowerCase();
  }

  const finalStatus = mapOutcomeToFinalStatus(outcome);
  const confirm = await repository.confirmDeliveryReceiptAtomic({
    companyId: user.company_id,
    actorId: user.id,
    deliveryId: delivery.id,
    finalStatus,
    itemOutcomes: Object.entries(itemsBuilt.outcomes).map(([deliveryItemId, o]) => ({ deliveryItemId, ...o })),
    reasonCode,
    reasonNote,
    severity,
    recipientName: requiresRecipient ? recipientName : null,
    isExpectedPic,
  });

  if (confirm.outcome === "quantity_conflict") {
    return { ok: false, error: "Jumlah melebihi sisa pesanan (kemungkinan sudah dikirim di percobaan lain). Hubungi admin." };
  }
  if (confirm.outcome === "forbidden" || confirm.outcome === "not_found") {
    return { ok: false, error: "Tidak bisa menyelesaikan pengiriman ini." };
  }
  const alreadyFinalized = confirm.outcome === "already_finalized";

  if (!alreadyFinalized && requiresRecipient && recipientName && isExpectedPic === false) {
    await repository.insertEvent({
      companyId: user.company_id, deliveryId: delivery.id, eventType: "recipient_changed", fromStatus: null, toStatus: null,
      actorId: user.id, telegramUpdateEventId: null, payload: { previousRecipient, newRecipient: recipientName, source },
    });
  }

  const finalized = (await repository.getDelivery(delivery.id)) ?? delivery;
  await repository.insertEvent({
    companyId: user.company_id, deliveryId: delivery.id, eventType: "finalized", fromStatus: delivery.status, toStatus: finalStatus,
    actorId: user.id, telegramUpdateEventId: null, payload: { outcome, source, locationMissing: !hasLocation, ...(asAdmin ? { inputByAdmin: user.id } : {}) },
  });

  if (!alreadyFinalized) {
    await repository.syncSalesOrderStatus(delivery.salesOrderId);
    const invoiceEligibility = computeInvoiceEligibility(finalized);
    if (requiresOwnerAlert(finalStatus, invoiceEligibility, finalized.exceptions)) {
      const payload = buildOwnerAlertPayload({
        customerName: "(lihat detail order)",
        orderReference: delivery.salesOrderId,
        finalStatus,
        invoiceEligibility,
        reason: reasonCode ?? "-",
        evidenceSummary: evidenceTypes.join(", ") || "tidak ada",
        actor: user.email,
      });
      await repository.insertOwnerAlert({
        companyId: user.company_id, salesOrderId: delivery.salesOrderId, deliveryId: delivery.id,
        alertType: "delivery_variance", channel: "whatsapp", severity: computeExceptionSeverity(outcome, invoiceEligibility), payload,
      });
    }
  }

  revalidatePath("/dashboard/deliveries");
  revalidatePath(`/dashboard/deliveries/${delivery.id}`);
  revalidatePath(`/dashboard/orders/${delivery.salesOrderId}`);
  return { ok: true };
}
