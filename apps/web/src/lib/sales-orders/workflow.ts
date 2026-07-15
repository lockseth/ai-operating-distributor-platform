// =============================================================================
// Workflow — orkestrator end-to-end untuk satu Telegram update.
//
// Dependency injection penuh (repository, knowledge provider, telegram
// sender) supaya seluruh alur bisa diuji tanpa Supabase/Telegram sungguhan.
// Route API (app/api/webhooks/telegram/route.ts) hanya memanggil
// processTelegramUpdate() setelah verifikasi secret + rate limit.
// =============================================================================

import type { TelegramUpdate, TelegramSender } from "@/lib/telegram/client";
import type { SalesOrderTelegramRepository, ResolvedIdentity } from "./repository";
import type { KnowledgeProvider } from "./knowledge-provider";
import type { PricedOrder } from "./types";
import { extractSalesOrder, isLikelyOrderMessage } from "./extraction";
import { buildPricedOrder } from "./pricing";
import {
  buildConfirmationSummary,
  buildUnrecognizedMessageReply,
  buildUnregisteredUserReply,
  buildVoiceNotePendingReply,
  buildAskForCorrectionReply,
  buildAlreadyConfirmedReply,
  buildNoPendingOrderReply,
  buildOrderConfirmedReply,
} from "./confirmation";

export interface WorkflowDeps {
  repository: SalesOrderTelegramRepository;
  knowledgeProvider: KnowledgeProvider;
  sender: TelegramSender;
}

export type ProcessResult =
  | { outcome: "duplicate_update" }
  | { outcome: "ignored_update_type" }
  | { outcome: "unregistered" }
  | { outcome: "voice_pending" }
  | { outcome: "not_order" }
  | { outcome: "draft_created"; orderId: string }
  | { outcome: "corrected_draft_updated"; orderId: string }
  | { outcome: "confirmed"; orderId: string; alreadyConfirmed: boolean }
  | { outcome: "awaiting_correction"; orderId: string }
  | { outcome: "no_pending_order" };

const CONFIRM_KEYWORD = "KONFIRMASI";
const CHANGE_KEYWORD = "UBAH";

export async function processTelegramUpdate(
  update: TelegramUpdate,
  deps: WorkflowDeps
): Promise<ProcessResult> {
  // --- Idempotency: update_id yang sama TIDAK PERNAH diproses dua kali. ---
  const existingEvent = await deps.repository.findEventByUpdateId(update.update_id);
  if (existingEvent) return { outcome: "duplicate_update" };

  const message = update.message;
  if (!message) {
    await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: null,
      telegramIdentityId: null,
      messageType: "other",
      processingStatus: "not_order",
      rawPayload: update,
    });
    return { outcome: "ignored_update_type" };
  }

  const chatId = message.chat.id;

  // --- Identitas SELALU di-resolve dari mapping internal, tidak pernah dari payload. ---
  const identity = await deps.repository.resolveIdentity(chatId);

  if (!identity) {
    await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: null,
      telegramIdentityId: null,
      messageType: message.voice ? "voice" : "text",
      processingStatus: "rejected_unregistered",
      rawPayload: update,
    });
    // Tidak membocorkan data internal — pesan generik saja.
    await deps.sender.sendMessage(chatId, buildUnregisteredUserReply());
    return { outcome: "unregistered" };
  }

  if (message.voice) {
    await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: identity.companyId,
      telegramIdentityId: identity.identityId,
      messageType: "voice",
      processingStatus: "transcription_pending",
      rawPayload: update,
    });
    await deps.sender.sendMessage(chatId, buildVoiceNotePendingReply());
    return { outcome: "voice_pending" };
  }

  const text = (message.text ?? "").trim();
  const event = await deps.repository.insertEvent({
    telegramUpdateId: update.update_id,
    companyId: identity.companyId,
    telegramIdentityId: identity.identityId,
    messageType: "text",
    processingStatus: "received",
    rawPayload: update,
  });

  const conversation = await deps.repository.getConversationState(identity.identityId);
  const normalizedText = text.toUpperCase();

  // --- Sales sedang diminta KONFIRMASI/UBAH atas draft yang sudah ada ---
  if (conversation.awaiting === "confirmation" && conversation.pendingOrderId) {
    if (normalizedText === CONFIRM_KEYWORD) {
      const { order, alreadyConfirmed } = await deps.repository.confirmOrder(conversation.pendingOrderId);
      await deps.repository.updateEventStatus(event.id, "processed", order.id);
      // State TIDAK direset ke "none" — dibiarkan "confirmation" supaya
      // KONFIRMASI berulang tetap masuk cabang ini dan ditangani idempotent
      // oleh confirmOrder() (alreadyConfirmed=true), bukan dianggap "tidak
      // ada order pending".
      await deps.repository.setConversationState(identity.identityId, identity.companyId, {
        pendingOrderId: order.id,
        awaiting: "confirmation",
      });
      await deps.sender.sendMessage(
        chatId,
        alreadyConfirmed ? buildAlreadyConfirmedReply() : buildOrderConfirmedReply(order.priced)
      );
      return { outcome: "confirmed", orderId: order.id, alreadyConfirmed };
    }

    if (normalizedText === CHANGE_KEYWORD) {
      const currentOrder = await deps.repository.getOrder(conversation.pendingOrderId);
      if (currentOrder && currentOrder.status !== "draft") {
        // Order sudah confirmed (atau status lain) — UBAH tidak berlaku lagi.
        await deps.repository.updateEventStatus(event.id, "not_order");
        await deps.sender.sendMessage(chatId, buildAlreadyConfirmedReply());
        return { outcome: "no_pending_order" };
      }
      await deps.repository.updateEventStatus(event.id, "processed", conversation.pendingOrderId);
      await deps.repository.setConversationState(identity.identityId, identity.companyId, {
        pendingOrderId: conversation.pendingOrderId,
        awaiting: "correction",
      });
      await deps.sender.sendMessage(chatId, buildAskForCorrectionReply());
      return { outcome: "awaiting_correction", orderId: conversation.pendingOrderId };
    }
    // Pesan lain saat menunggu KONFIRMASI/UBAH: jatuh ke bawah, diperlakukan
    // sebagai upaya order baru (draft lama tetap ada, tidak dihapus).
  }

  // --- Sales baru saja UBAH, ini teks koreksinya ---
  if (conversation.awaiting === "correction" && conversation.pendingOrderId) {
    return await handleCorrection(text, chatId, identity, conversation.pendingOrderId, event.id, deps);
  }

  // --- KONFIRMASI/UBAH tanpa draft yang sedang ditunggu ---
  if (normalizedText === CONFIRM_KEYWORD || normalizedText === CHANGE_KEYWORD) {
    await deps.repository.updateEventStatus(event.id, "not_order");
    await deps.sender.sendMessage(chatId, buildNoPendingOrderReply());
    return { outcome: "no_pending_order" };
  }

  // --- Jalur normal: ekstraksi order baru ---
  return await handleNewOrderText(text, chatId, identity, event.id, deps);
}

async function handleNewOrderText(
  text: string,
  chatId: number,
  identity: ResolvedIdentity,
  eventId: string,
  deps: WorkflowDeps
): Promise<ProcessResult> {
  const knowledge = await deps.knowledgeProvider.getContext(identity.companyId);
  const extracted = extractSalesOrder(text, knowledge);

  if (!isLikelyOrderMessage(extracted)) {
    await deps.repository.updateEventStatus(eventId, "not_order");
    await deps.sender.sendMessage(chatId, buildUnrecognizedMessageReply());
    return { outcome: "not_order" };
  }

  const priced = buildPricedOrder(extracted, knowledge);

  const created = await deps.repository.createDraftOrder({
    companyId: identity.companyId,
    salesId: identity.userId,
    priced,
    knowledgeVersion: knowledge.knowledgeVersion,
    extractionConfidence: extracted.confidence,
    missingFields: extracted.missingFields,
    telegramEventId: eventId,
  });

  await deps.repository.updateEventStatus(eventId, "processed", created.id);
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingOrderId: created.id,
    awaiting: "confirmation",
  });

  await deps.sender.sendMessage(chatId, buildConfirmationSummary(priced));
  return { outcome: "draft_created", orderId: created.id };
}

async function handleCorrection(
  text: string,
  chatId: number,
  identity: ResolvedIdentity,
  pendingOrderId: string,
  eventId: string,
  deps: WorkflowDeps
): Promise<ProcessResult> {
  const previous = await deps.repository.getOrder(pendingOrderId);
  const knowledge = await deps.knowledgeProvider.getContext(identity.companyId);
  const extracted = extractSalesOrder(text, knowledge);

  if (!isLikelyOrderMessage(extracted)) {
    await deps.repository.updateEventStatus(eventId, "not_order");
    await deps.sender.sendMessage(chatId, buildUnrecognizedMessageReply());
    return { outcome: "not_order" };
  }

  const priced = buildPricedOrder(extracted, knowledge);

  if (previous) {
    await submitDiffAsCandidates(deps, identity, previous.priced, priced, pendingOrderId);
  }

  await deps.repository.updateDraftOrder(pendingOrderId, {
    priced,
    knowledgeVersion: knowledge.knowledgeVersion,
    extractionConfidence: extracted.confidence,
    missingFields: extracted.missingFields,
  });

  await deps.repository.updateEventStatus(eventId, "processed", pendingOrderId);
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingOrderId,
    awaiting: "confirmation",
  });

  await deps.sender.sendMessage(chatId, buildConfirmationSummary(priced));
  return { outcome: "corrected_draft_updated", orderId: pendingOrderId };
}

/**
 * Simpan perbedaan antara draft sebelum & sesudah koreksi sebagai
 * knowledge_candidate. Pemasangan dilakukan per-index (heuristik MVP —
 * mengasumsikan urutan item tidak berubah antara pesan asli dan koreksi).
 * TIDAK PERNAH auto-published; hanya submitCandidate (status selalu pending).
 */
async function submitDiffAsCandidates(
  deps: WorkflowDeps,
  identity: ResolvedIdentity,
  before: PricedOrder,
  after: PricedOrder,
  sourceOrderId: string
): Promise<void> {
  if (before.customerName && after.customerName && before.customerName !== after.customerName) {
    await deps.knowledgeProvider.submitCandidate({
      companyId: identity.companyId,
      candidateType: "customer_alias",
      rawText: before.customerName,
      suggestedValue: { customerId: after.customerId, canonicalName: after.customerName },
      sourceOrderId,
      submittedBy: identity.userId,
    });
  }

  const n = Math.min(before.items.length, after.items.length);
  for (let i = 0; i < n; i++) {
    const beforeItem = before.items[i]!;
    const afterItem = after.items[i]!;
    if (beforeItem.productName && afterItem.productName && beforeItem.productName !== afterItem.productName) {
      await deps.knowledgeProvider.submitCandidate({
        companyId: identity.companyId,
        candidateType: "product_alias",
        rawText: beforeItem.productName,
        suggestedValue: { productId: afterItem.productId, canonicalName: afterItem.productName },
        sourceOrderId,
        submittedBy: identity.userId,
      });
    }
  }
}
