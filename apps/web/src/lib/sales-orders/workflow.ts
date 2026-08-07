// =============================================================================
// Workflow — orkestrator end-to-end untuk satu Telegram update.
//
// Dependency injection penuh (repository, knowledge provider, telegram
// sender) supaya seluruh alur bisa diuji tanpa Supabase/Telegram sungguhan.
// Route API (app/api/webhooks/telegram/route.ts) hanya memanggil
// processTelegramUpdate() setelah verifikasi secret + rate limit.
// =============================================================================

import type { TelegramUpdate, TelegramSender } from "@/lib/telegram/client";
import {
  DraftOrderRejectedError,
  type SalesOrderTelegramRepository,
  type ResolvedIdentity,
} from "./repository";
import type { KnowledgeProvider } from "./knowledge-provider";
import type { KnowledgeContext, PricedOrder } from "./types";
import type { ExtractedSalesOrder } from "@flowsales/ai";
import { extractSalesOrder, isLikelyOrderMessage } from "./extraction";
import { buildPricedOrder } from "./pricing";
import { detectOrderSource } from "./order-source";
import { canonicalJsonStringify } from "./normalize";
import {
  buildConfirmationSummary,
  buildUnrecognizedMessageReply,
  buildUnregisteredUserReply,
  buildVoiceNotePendingReply,
  buildAskForCorrectionReply,
  buildAlreadyConfirmedReply,
  buildNoPendingOrderReply,
  buildOrderConfirmedReply,
  buildOrderRejectedReply,
  buildProcessingErrorReply,
} from "./confirmation";
import type { DeliveryRepositoryInterface } from "@/lib/delivery/repository";
import {
  processDeliveryConversation,
  type DeliveryProcessResult,
} from "@/lib/delivery/workflow";
import type { TelegramEnrollmentRepository } from "@/lib/telegram-enrollment/repository";
import {
  buildEnrollmentReply,
  processTelegramEnrollment,
} from "@/lib/telegram-enrollment/workflow";

export interface WorkflowDeps {
  repository: SalesOrderTelegramRepository;
  knowledgeProvider: KnowledgeProvider;
  sender: TelegramSender;
  deliveryRepository: DeliveryRepositoryInterface;
  enrollmentRepository: TelegramEnrollmentRepository;
}

export type ProcessResult =
  | { outcome: "duplicate_update" }
  | { outcome: "duplicate_conflict" }
  | { outcome: "ignored_update_type" }
  | { outcome: "enrollment_claimed" }
  | { outcome: "enrollment_rejected" }
  | { outcome: "unregistered" }
  | { outcome: "voice_pending" }
  | { outcome: "not_order" }
  | { outcome: "processing_error" }
  | { outcome: "draft_created"; orderId: string }
  | { outcome: "corrected_draft_updated"; orderId: string }
  | { outcome: "order_rejected"; reason: string }
  | { outcome: "confirmed"; orderId: string; alreadyConfirmed: boolean }
  | { outcome: "awaiting_correction"; orderId: string }
  | { outcome: "no_pending_order" }
  | { outcome: "delivery"; result: DeliveryProcessResult };

/**
 * missingFields gabungan dari hasil ekstraksi (extraction.ts, ambiguitas
 * alias/nama toko/produk) DAN hasil pricing (pricing.ts, ambiguitas resolusi
 * id via fallback nama kanonik -- lihat pricing.ts, customers.name/products.name
 * TIDAK unique per company). Draft TETAP dibuat (customerId/productId sengaja
 * null saat ambigu, bukan ditolak) -- konsisten dengan pola NOT_FOUND yang
 * sudah ada, hanya menambah alasan review di missing_fields.
 */
function mergeAmbiguityMissingFields(extractedMissingFields: string[], priced: PricedOrder): string[] {
  const ambiguityFields: string[] = [];
  if (priced.customerAmbiguous) ambiguityFields.push("customer.ambiguous");
  priced.items.forEach((item, i) => {
    if (item.productAmbiguous) ambiguityFields.push(`items[${i}].productName.ambiguous`);
  });
  const merged = new Set([...extractedMissingFields, ...ambiguityFields]);
  return Array.from(merged);
}

const CONFIRM_KEYWORD = "KONFIRMASI";
const CHANGE_KEYWORD = "UBAH";

/**
 * Gate 3E-D4-C7: bukti langsung (raw_payload SO-2608-0001, hosted
 * mcbwgvtkhykrrtvbpeys) menunjukkan Sales mengetik "Konfimasi" (satu huruf
 * hilang) saat draft sedang menunggu konfirmasi -- exact-match sebelumnya
 * (trim+uppercase saja) menolaknya sehingga jatuh ke parser order. Toleransi
 * typo tunggal generik (bukan pengecualian Salma) lewat Levenshtein
 * distance<=1 terhadap "KONFIRMASI" -- 10 huruf cukup unik sehingga jarak<=1
 * TIDAK PERNAH kebetulan cocok dengan teks order asli (order text jauh lebih
 * panjang/berbeda struktur). Sengaja HANYA diterapkan pada perbandingan
 * KONFIRMASI di alur "sedang menunggu konfirmasi" (bukan CHANGE_KEYWORD yang
 * pendek/berisiko false-positive, dan bukan standalone "tanpa pending draft"
 * check) -- lihat pemakaian di bawah.
 */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

function isConfirmCommand(normalizedText: string): boolean {
  return levenshteinDistance(normalizedText, CONFIRM_KEYWORD) <= 1;
}

export async function processTelegramUpdate(
  update: TelegramUpdate,
  deps: WorkflowDeps,
): Promise<ProcessResult> {
  // --- Idempotency: update_id yang sama TIDAK PERNAH diproses dua kali. ---
  const existingEvent = await deps.repository.findEventByUpdateId(
    update.update_id,
  );
  if (existingEvent) {
    // update_id sama TAPI payload berbeda dari yang tersimpan -- BUKAN retry
    // biasa. Fail closed: jangan diperlakukan seperti duplicate_update biasa
    // (yang sudah aman, tidak menulis apa pun), catat sebagai conflict, dan
    // JANGAN PERNAH menyentuh raw_payload yang sudah tersimpan. rawPayload
    // null berarti event ini memang tidak pernah menyimpan payload (mis.
    // handshake chat belum terdaftar, lihat insertEvent di bawah) -- tidak
    // ada dasar pembanding, perlakukan seperti retry biasa.
    if (existingEvent.rawPayload !== null && existingEvent.rawPayload !== undefined) {
      const unchanged =
        canonicalJsonStringify(existingEvent.rawPayload) === canonicalJsonStringify(update);
      if (!unchanged) {
        console.error(
          `[Telegram] update_id ${update.update_id} conflict: payload baru berbeda dari yang sudah tersimpan (event ${existingEvent.id}). Ditolak fail-closed, raw_payload asli tidak diubah.`,
        );
        return { outcome: "duplicate_conflict" };
      }
    }
    return { outcome: "duplicate_update" };
  }

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
    // Enrollment didahulukan sebelum handshake generik. Token mentah tidak
    // pernah masuk event ledger; workflow enrollment hanya meneruskan
    // SHA-256(token) ke routine claim atomik.
    const enrollment = await processTelegramEnrollment(
      message,
      deps.enrollmentRepository,
    );
    if (enrollment.outcome !== "not_enrollment") {
      const claimed =
        enrollment.outcome === "claimed" ? enrollment.identity : null;
      await deps.repository.insertEvent({
        telegramUpdateId: update.update_id,
        companyId: claimed?.companyId ?? null,
        telegramIdentityId: claimed?.identityId ?? null,
        messageType: "text",
        processingStatus:
          enrollment.outcome === "claimed"
            ? "processed"
            : "rejected_unregistered",
        rawPayload: null,
        telegramChatId: chatId,
        telegramUserId: message.from?.id ?? null,
        telegramUsername: message.from?.username ?? null,
        rejectionReason:
          enrollment.outcome === "rejected"
            ? `enrollment_${enrollment.reason}`
            : undefined,
      });
      await deps.sender.sendMessage(chatId, buildEnrollmentReply(enrollment));
      return {
        outcome:
          enrollment.outcome === "claimed"
            ? "enrollment_claimed"
            : "enrollment_rejected",
      };
    }

    // Handshake dari chat yang belum terdaftar: JANGAN simpan raw_payload
    // (isi pesan) — cukup metadata minimum untuk keperluan registrasi
    // identitas nanti (lihat prosedur "update pertama" di
    // docs/architecture/TELEGRAM_SALES_ORDER_ENTRY.md). username hanya
    // label tampilan, bukan identitas tepercaya.
    await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: null,
      telegramIdentityId: null,
      messageType: message.voice ? "voice" : "text",
      processingStatus: "rejected_unregistered",
      rawPayload: null,
      telegramChatId: chatId,
      telegramUserId: message.from?.id ?? null,
      telegramUsername: message.from?.username ?? null,
      rejectionReason: "unregistered_chat",
    });
    // Tidak membocorkan data internal — pesan generik saja.
    await deps.sender.sendMessage(chatId, buildUnregisteredUserReply());
    return { outcome: "unregistered" };
  }

  // --- Gate 3E-D1-R1: pairing digeneralisasi ke {owner, admin, sales}, tapi
  // seluruh workflow di bawah ini (Sales Order, Delivery, Dispute, Menu)
  // adalah capability 'sales.order.telegram' -- HANYA role sales. Owner/admin
  // yang paired (untuk password.reset.self, belum diimplementasikan) TIDAK
  // otomatis dapat akses di sini. Dicek ulang dari state SAAT INI (bukan
  // diasumsikan dari resolveIdentity) supaya role yang berubah setelah
  // pairing langsung fail-closed. Balasan ke pengirim DISAMAKAN dengan
  // "unregistered" -- pola yang sama dengan claim-time eligibility corrective
  // (Gate 1C) -- supaya tidak membocorkan bahwa chat ini sebenarnya paired
  // tapi tidak eligible untuk workflow ini.
  const eligibleForSalesOrder = await deps.repository.hasSalesOrderCapability(
    identity.userId,
    identity.companyId,
  );
  if (!eligibleForSalesOrder) {
    await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: identity.companyId,
      telegramIdentityId: identity.identityId,
      messageType: message.voice ? "voice" : "text",
      processingStatus: "rejected_unregistered",
      rawPayload: null,
      telegramChatId: chatId,
      telegramUserId: message.from?.id ?? null,
      telegramUsername: message.from?.username ?? null,
      rejectionReason: "capability_denied_sales_order_telegram",
    });
    await deps.sender.sendMessage(chatId, buildUnregisteredUserReply());
    return { outcome: "unregistered" };
  }

  // --- Alur Delivery Verification (driver) didahulukan bila sedang berjalan
  // untuk identity ini. Satu bot Telegram, satu ledger idempotency
  // (telegram_update_events) melayani kedua alur — lihat lib/delivery/repository.ts. ---
  const deliveryState = await deps.deliveryRepository.getConversationState(
    identity.identityId,
  );
  if (deliveryState.awaiting !== "none") {
    const deliveryEvent = await deps.repository.insertEvent({
      telegramUpdateId: update.update_id,
      companyId: identity.companyId,
      telegramIdentityId: identity.identityId,
      messageType: message.voice ? "voice" : message.text ? "text" : "other",
      processingStatus: "received",
      rawPayload: update,
    });
    const deliveryResult = await processDeliveryConversation(
      message,
      chatId,
      identity,
      deliveryState,
      deliveryEvent.id,
      {
        repository: deps.deliveryRepository,
        sender: deps.sender,
      },
    );
    await deps.repository.updateEventStatus(deliveryEvent.id, "processed");
    return { outcome: "delivery", result: deliveryResult };
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

  const conversation = await deps.repository.getConversationState(
    identity.identityId,
  );
  const normalizedText = text.toUpperCase();

  // --- Sales sedang diminta KONFIRMASI/UBAH atas draft yang sudah ada ---
  if (conversation.awaiting === "confirmation" && conversation.pendingOrderId) {
    if (isConfirmCommand(normalizedText)) {
      const { order, alreadyConfirmed } = await deps.repository.confirmOrder(
        conversation.pendingOrderId,
        identity.companyId,
        identity.userId,
      );
      await deps.repository.updateEventStatus(event.id, "processed", order.id);
      // State TIDAK direset ke "none" — dibiarkan "confirmation" supaya
      // KONFIRMASI berulang tetap masuk cabang ini dan ditangani idempotent
      // oleh confirmOrder() (alreadyConfirmed=true), bukan dianggap "tidak
      // ada order pending".
      await deps.repository.setConversationState(
        identity.identityId,
        identity.companyId,
        {
          pendingOrderId: order.id,
          awaiting: "confirmation",
        },
      );
      await deps.sender.sendMessage(
        chatId,
        alreadyConfirmed
          ? buildAlreadyConfirmedReply()
          : buildOrderConfirmedReply(order.orderNumber, order.priced),
      );
      return { outcome: "confirmed", orderId: order.id, alreadyConfirmed };
    }

    if (normalizedText === CHANGE_KEYWORD) {
      const currentOrder = await deps.repository.getOrder(
        conversation.pendingOrderId,
      );
      if (currentOrder && currentOrder.status !== "draft") {
        // Order sudah confirmed (atau status lain) — UBAH tidak berlaku lagi.
        await deps.repository.updateEventStatus(event.id, "not_order");
        await deps.sender.sendMessage(chatId, buildAlreadyConfirmedReply());
        return { outcome: "no_pending_order" };
      }
      await deps.repository.updateEventStatus(
        event.id,
        "processed",
        conversation.pendingOrderId,
      );
      await deps.repository.setConversationState(
        identity.identityId,
        identity.companyId,
        {
          pendingOrderId: conversation.pendingOrderId,
          awaiting: "correction",
        },
      );
      await deps.sender.sendMessage(chatId, buildAskForCorrectionReply());
      return {
        outcome: "awaiting_correction",
        orderId: conversation.pendingOrderId,
      };
    }
    // Pesan lain saat menunggu KONFIRMASI/UBAH: jatuh ke bawah, diperlakukan
    // sebagai upaya order baru (draft lama tetap ada, tidak dihapus).
  }

  // --- Sales baru saja UBAH, ini teks koreksinya ---
  if (conversation.awaiting === "correction" && conversation.pendingOrderId) {
    return await handleCorrection(
      text,
      chatId,
      identity,
      conversation.pendingOrderId,
      event.id,
      deps,
    );
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
  deps: WorkflowDeps,
): Promise<ProcessResult> {
  let knowledge: KnowledgeContext, extracted: ExtractedSalesOrder, priced: PricedOrder;
  try {
    // Parser deterministik (extractSalesOrder/buildPricedOrder) didesain
    // untuk tidak pernah throw pada input tak valid -- satu-satunya
    // kegagalan realistis di sini adalah provider Knowledge Pack (mis.
    // Supabase/DB bermasalah). Fail closed: event ditandai 'error' eksplisit
    // (bukan tersangkut selamanya di 'received'), pesan asli TETAP tersimpan
    // (sudah di-insert sebelum fungsi ini dipanggil), dan TIDAK ADA order
    // yang tercipta.
    knowledge = await deps.knowledgeProvider.getContext(identity.companyId);
    extracted = extractSalesOrder(text, knowledge);
    priced = buildPricedOrder(extracted, knowledge);
  } catch (err) {
    console.error(`[Telegram] gagal memproses order (event ${eventId}):`, err);
    await deps.repository.updateEventStatus(
      eventId,
      "error",
      null,
      err instanceof Error ? err.message : "unknown_processing_error",
    );
    await deps.sender.sendMessage(chatId, buildProcessingErrorReply());
    return { outcome: "processing_error" };
  }

  if (!isLikelyOrderMessage(extracted)) {
    await deps.repository.updateEventStatus(eventId, "not_order");
    await deps.sender.sendMessage(chatId, buildUnrecognizedMessageReply());
    return { outcome: "not_order" };
  }

  let created;
  try {
    created = await deps.repository.createDraftOrder({
      companyId: identity.companyId,
      salesId: identity.userId,
      priced,
      knowledgeVersion: knowledge.knowledgeVersion,
      extractionConfidence: extracted.confidence,
      missingFields: mergeAmbiguityMissingFields(extracted.missingFields, priced),
      telegramEventId: eventId,
      orderSource: detectOrderSource(text),
    });
  } catch (err) {
    if (err instanceof DraftOrderRejectedError) {
      await deps.repository.updateEventStatus(eventId, "not_order");
      await deps.sender.sendMessage(chatId, buildOrderRejectedReply(err.code));
      return { outcome: "order_rejected", reason: err.code };
    }
    throw err;
  }

  await deps.repository.updateEventStatus(eventId, "processed", created.id);
  await deps.repository.setConversationState(
    identity.identityId,
    identity.companyId,
    {
      pendingOrderId: created.id,
      awaiting: "confirmation",
    },
  );

  await deps.sender.sendMessage(chatId, buildConfirmationSummary(priced, created.orderNumber));
  return { outcome: "draft_created", orderId: created.id };
}

async function handleCorrection(
  text: string,
  chatId: number,
  identity: ResolvedIdentity,
  pendingOrderId: string,
  eventId: string,
  deps: WorkflowDeps,
): Promise<ProcessResult> {
  const previous = await deps.repository.getOrder(pendingOrderId);

  let knowledge: KnowledgeContext, extracted: ExtractedSalesOrder, priced: PricedOrder;
  try {
    // Lihat catatan fail-closed yang sama di handleNewOrderText.
    knowledge = await deps.knowledgeProvider.getContext(identity.companyId);
    extracted = extractSalesOrder(text, knowledge);
    priced = buildPricedOrder(extracted, knowledge);
  } catch (err) {
    console.error(`[Telegram] gagal memproses koreksi order (event ${eventId}):`, err);
    await deps.repository.updateEventStatus(
      eventId,
      "error",
      null,
      err instanceof Error ? err.message : "unknown_processing_error",
    );
    await deps.sender.sendMessage(chatId, buildProcessingErrorReply());
    return { outcome: "processing_error" };
  }

  if (!isLikelyOrderMessage(extracted)) {
    await deps.repository.updateEventStatus(eventId, "not_order");
    await deps.sender.sendMessage(chatId, buildUnrecognizedMessageReply());
    return { outcome: "not_order" };
  }

  if (previous) {
    await submitDiffAsCandidates(
      deps,
      identity,
      previous.priced,
      priced,
      pendingOrderId,
    );
  }

  let updated;
  try {
    updated = await deps.repository.updateDraftOrder(pendingOrderId, {
      companyId: identity.companyId,
      actorId: identity.userId,
      priced,
      knowledgeVersion: knowledge.knowledgeVersion,
      extractionConfidence: extracted.confidence,
      missingFields: mergeAmbiguityMissingFields(extracted.missingFields, priced),
      orderSource: detectOrderSource(text),
    });
  } catch (err) {
    if (err instanceof DraftOrderRejectedError) {
      await deps.repository.updateEventStatus(eventId, "not_order");
      await deps.sender.sendMessage(chatId, buildOrderRejectedReply(err.code));
      return { outcome: "order_rejected", reason: err.code };
    }
    throw err;
  }

  await deps.repository.updateEventStatus(eventId, "processed", pendingOrderId);
  await deps.repository.setConversationState(
    identity.identityId,
    identity.companyId,
    {
      pendingOrderId,
      awaiting: "confirmation",
    },
  );

  await deps.sender.sendMessage(chatId, buildConfirmationSummary(priced, updated.orderNumber));
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
  sourceOrderId: string,
): Promise<void> {
  if (
    before.customerName &&
    after.customerName &&
    before.customerName !== after.customerName
  ) {
    await deps.knowledgeProvider.submitCandidate({
      companyId: identity.companyId,
      candidateType: "customer_alias",
      rawText: before.customerName,
      suggestedValue: {
        customerId: after.customerId,
        canonicalName: after.customerName,
      },
      sourceOrderId,
      submittedBy: identity.userId,
    });
  }

  const n = Math.min(before.items.length, after.items.length);
  for (let i = 0; i < n; i++) {
    const beforeItem = before.items[i]!;
    const afterItem = after.items[i]!;
    if (
      beforeItem.productName &&
      afterItem.productName &&
      beforeItem.productName !== afterItem.productName
    ) {
      await deps.knowledgeProvider.submitCandidate({
        companyId: identity.companyId,
        candidateType: "product_alias",
        rawText: beforeItem.productName,
        suggestedValue: {
          productId: afterItem.productId,
          canonicalName: afterItem.productName,
        },
        sourceOrderId,
        submittedBy: identity.userId,
      });
    }
  }
}
