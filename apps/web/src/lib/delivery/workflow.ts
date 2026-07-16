// =============================================================================
// Workflow — orkestrator percakapan Telegram untuk eksekusi Delivery
// Verification oleh driver. Dipanggil dari lib/sales-orders/workflow.ts saat
// delivery_conversation_state identity menunjukkan ada alur delivery
// berjalan (satu bot Telegram, satu idempotency ledger — lihat catatan di
// repository.ts).
//
// Business logic (reconciliation, evidence rule, invoice eligibility) ada di
// service.ts — modul ini murni orkestrasi state machine + I/O Telegram.
// =============================================================================

import type { TelegramUpdate, TelegramSender } from "@/lib/telegram/client";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";
import type { DeliveryRepositoryInterface, DeliveryConversationState } from "./repository";
import type { DeliveryItemRecord, DeliveryOutcome, DeliveryStatus, DeliveryRecord, EvidenceType, ReasonCode } from "./types";
import { REASON_CODES } from "./types";
import {
  mapOutcomeToFinalStatus,
  evidenceRequirementFor,
  validateEvidence,
  validateReasonNote,
  computeDiscrepancies,
  computeInvoiceEligibility,
  computeExceptionSeverity,
  requiresOwnerAlert,
  buildOwnerAlertPayload,
} from "./service";
import {
  DELIVERY_OUTCOME_KEYWORDS,
  START_DELIVERY_KEYWORD,
  CONFIRM_DELIVERY_KEYWORD,
  buildDispatchedReply,
  buildAskQuantityReply,
  buildInvalidQuantityReply,
  buildQuantityExceedsOutstandingReply,
  buildQuantityConflictReply,
  buildAskReasonReply,
  buildInvalidReasonReply,
  buildAskReasonNoteReply,
  buildAskEvidenceReply,
  buildReconciliationPreview,
  buildFinalConfirmedReply,
  buildAlreadyFinalizedReply,
  buildNoPendingDeliveryReply,
  buildUnknownOutcomeReply,
} from "./confirmation";

export interface DeliveryWorkflowDeps {
  repository: DeliveryRepositoryInterface;
  sender: TelegramSender;
}

export type DeliveryProcessResult =
  | { outcome: "dispatched"; deliveryId: string }
  | { outcome: "outcome_recorded"; deliveryId: string }
  | { outcome: "quantity_recorded"; deliveryId: string }
  | { outcome: "reason_recorded"; deliveryId: string }
  | { outcome: "reason_note_recorded"; deliveryId: string }
  | { outcome: "evidence_recorded"; deliveryId: string }
  | { outcome: "preview_shown"; deliveryId: string }
  | { outcome: "finalized"; deliveryId: string; alreadyFinalized: boolean; finalStatus: DeliveryStatus }
  | { outcome: "quantity_conflict"; deliveryId: string }
  | { outcome: "invalid_input" }
  | { outcome: "no_pending_delivery" };

interface DraftItemOutcome {
  receivedQuantity: number;
  rejectedQuantity: number;
  returnedQuantity: number;
  unresolvedQuantity: number;
}

interface DraftState {
  outcome?: DeliveryOutcome;
  itemOutcomes?: Record<string, DraftItemOutcome>;
  reasonCode?: ReasonCode;
  reasonNote?: string | null;
  evidenceTypes?: EvidenceType[];
  hasRecipient?: boolean;
  recipientName?: string;
  hasLocation?: boolean;
  location?: { latitude: number; longitude: number };
}

/** Entry point dipanggil dari sales-orders/workflow.ts saat awaiting delivery != 'none'. */
export async function processDeliveryConversation(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  state: DeliveryConversationState,
  telegramUpdateEventId: string,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  if (!state.pendingDeliveryId) {
    await deps.sender.sendMessage(chatId, buildNoPendingDeliveryReply());
    return { outcome: "no_pending_delivery" };
  }

  const delivery = await deps.repository.getDelivery(state.pendingDeliveryId);
  if (!delivery) {
    await deps.sender.sendMessage(chatId, buildNoPendingDeliveryReply());
    return { outcome: "no_pending_delivery" };
  }

  switch (state.awaiting) {
    case "start_confirmation":
      return handleStartConfirmation(message, chatId, identity, delivery.id, delivery.salesOrderId, telegramUpdateEventId, deps);
    case "outcome_selection":
      return handleOutcomeSelection(message, chatId, identity, delivery.id, state, telegramUpdateEventId, deps);
    case "item_quantity":
      return handleItemQuantity(message, chatId, identity, delivery, state, deps);
    case "reason_selection":
      return handleReasonSelection(message, chatId, identity, delivery, state, deps);
    case "reason_note":
      return handleReasonNote(message, chatId, identity, delivery, state, deps);
    case "evidence":
      return handleEvidence(message, chatId, identity, delivery, state, deps);
    case "final_confirmation":
      return handleFinalConfirmation(message, chatId, identity, delivery, state, telegramUpdateEventId, deps);
    default:
      await deps.sender.sendMessage(chatId, buildNoPendingDeliveryReply());
      return { outcome: "no_pending_delivery" };
  }
}

async function handleStartConfirmation(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  deliveryId: string,
  salesOrderId: string,
  telegramUpdateEventId: string,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const text = (message.text ?? "").trim().toUpperCase();
  if (text !== START_DELIVERY_KEYWORD) {
    await deps.sender.sendMessage(chatId, `Balas "${START_DELIVERY_KEYWORD}" saat siap berangkat.`);
    return { outcome: "invalid_input" };
  }

  await deps.repository.recordDispatch(deliveryId);
  // Delivery pertama untuk order ini benar-benar mulai bergerak -> lifecycle
  // agregat confirmed -> delivering (no-op idempoten bila order sudah
  // delivering dari attempt sebelumnya, lihat sync_sales_order_delivery_status).
  await deps.repository.syncSalesOrderStatus(salesOrderId);
  await deps.repository.insertEvent({
    companyId: identity.companyId,
    deliveryId,
    eventType: "dispatched",
    fromStatus: "planned",
    toStatus: "dispatched",
    actorId: identity.userId,
    telegramUpdateEventId,
    payload: {},
  });
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: deliveryId,
    awaiting: "outcome_selection",
    currentItemIndex: 0,
    draftState: {},
  });
  await deps.sender.sendMessage(chatId, buildDispatchedReply());
  return { outcome: "dispatched", deliveryId };
}

async function handleOutcomeSelection(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  deliveryId: string,
  state: DeliveryConversationState,
  telegramUpdateEventId: string,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const text = (message.text ?? "").trim().toUpperCase();
  const outcome = DELIVERY_OUTCOME_KEYWORDS[text];
  if (!outcome) {
    await deps.sender.sendMessage(chatId, buildUnknownOutcomeReply());
    return { outcome: "invalid_input" };
  }

  await deps.repository.recordArrival(deliveryId);
  await deps.repository.insertEvent({
    companyId: identity.companyId,
    deliveryId,
    eventType: "outcome_selected",
    fromStatus: "dispatched",
    toStatus: "arrived",
    actorId: identity.userId,
    telegramUpdateEventId,
    payload: { outcome },
  });

  const draft: DraftState = { outcome, itemOutcomes: {} };

  if (outcome === "full" || outcome === "store_closed" || outcome === "failed") {
    // full: seluruh item dianggap diterima penuh (tidak perlu tanya per-item).
    // store_closed/failed: tidak ada barang berpindah tangan sama sekali —
    // seluruh dispatched masuk unresolved (menunggu reschedule), bukan ditanya
    // per-item (Gate tidak merinci ini; MVP menghindari prompt yang tidak relevan).
    const delivery = await deps.repository.getDelivery(deliveryId);
    if (delivery) {
      for (const item of delivery.items) {
        draft.itemOutcomes![item.id] =
          outcome === "full"
            ? { receivedQuantity: item.dispatchedQuantity, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 }
            : { receivedQuantity: 0, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: item.dispatchedQuantity };
      }
    }

    if (outcome === "store_closed") {
      draft.reasonCode = "STORE_CLOSED";
      await advanceToEvidence(chatId, identity, deliveryId, draft, deps);
      return { outcome: "outcome_recorded", deliveryId };
    }
    if (outcome === "failed") {
      await deps.repository.setConversationState(identity.identityId, identity.companyId, {
        pendingDeliveryId: deliveryId,
        awaiting: "reason_selection",
        currentItemIndex: 0,
        draftState: draft as unknown as Record<string, unknown>,
      });
      await deps.sender.sendMessage(chatId, buildAskReasonReply());
      return { outcome: "outcome_recorded", deliveryId };
    }
    // full
    await advanceToEvidence(chatId, identity, deliveryId, draft, deps);
    return { outcome: "outcome_recorded", deliveryId };
  }

  // partial / rejected -> tanya jumlah per item.
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: deliveryId,
    awaiting: "item_quantity",
    currentItemIndex: 0,
    draftState: draft as unknown as Record<string, unknown>,
  });
  const delivery = await deps.repository.getDelivery(deliveryId);
  const firstItem = delivery?.items[0];
  if (firstItem) {
    await deps.sender.sendMessage(
      chatId,
      buildAskQuantityReply(firstItem.productName, firstItem.unit, firstItem.dispatchedQuantity, 0, delivery!.items.length)
    );
  }
  return { outcome: "outcome_recorded", deliveryId };
}

async function handleItemQuantity(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  delivery: { id: string; items: DeliveryItemRecord[] },
  state: DeliveryConversationState,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const item = delivery.items[state.currentItemIndex];
  if (!item) {
    await deps.sender.sendMessage(chatId, buildNoPendingDeliveryReply());
    return { outcome: "no_pending_delivery" };
  }

  const text = (message.text ?? "").trim();
  const received = Number(text);
  if (!Number.isFinite(received) || received < 0 || received > item.dispatchedQuantity || !Number.isInteger(received * 1000)) {
    await deps.sender.sendMessage(chatId, buildInvalidQuantityReply(item.dispatchedQuantity));
    return { outcome: "invalid_input" };
  }

  // Validasi dini (UX cepat, TIDAK silent clamp) terhadap outstanding lintas
  // delivery attempt lain untuk sales_order_item yang sama -- penegakan
  // OTORITATIF tetap terjadi atomic di finalizeItemQuantities() saat
  // KONFIRMASI KIRIM (lihat handleFinalConfirmation), ini murni feedback awal
  // supaya driver tidak perlu menuntaskan seluruh alur evidence dulu baru tahu.
  const outstanding = await deps.repository.getOutstandingQuantity(item.salesOrderItemId, item.id);
  if (received > outstanding) {
    await deps.sender.sendMessage(chatId, buildQuantityExceedsOutstandingReply(outstanding));
    return { outcome: "invalid_input" };
  }

  const draft = (state.draftState as unknown as DraftState) ?? {};
  const outcome = draft.outcome!;
  const remainder = item.dispatchedQuantity - received;
  draft.itemOutcomes = draft.itemOutcomes ?? {};
  draft.itemOutcomes[item.id] =
    outcome === "rejected"
      ? { receivedQuantity: received, rejectedQuantity: remainder, returnedQuantity: 0, unresolvedQuantity: 0 }
      : { receivedQuantity: received, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: remainder };

  const nextIndex = state.currentItemIndex + 1;
  if (nextIndex < delivery.items.length) {
    await deps.repository.setConversationState(identity.identityId, identity.companyId, {
      pendingDeliveryId: delivery.id,
      awaiting: "item_quantity",
      currentItemIndex: nextIndex,
      draftState: draft as unknown as Record<string, unknown>,
    });
    const nextItem = delivery.items[nextIndex]!;
    await deps.sender.sendMessage(
      chatId,
      buildAskQuantityReply(nextItem.productName, nextItem.unit, nextItem.dispatchedQuantity, nextIndex, delivery.items.length)
    );
    return { outcome: "quantity_recorded", deliveryId: delivery.id };
  }

  // Semua item selesai -> lanjut ke reason.
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "reason_selection",
    currentItemIndex: 0,
    draftState: draft as unknown as Record<string, unknown>,
  });
  await deps.sender.sendMessage(chatId, buildAskReasonReply());
  return { outcome: "quantity_recorded", deliveryId: delivery.id };
}

async function handleReasonSelection(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  delivery: { id: string },
  state: DeliveryConversationState,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const text = (message.text ?? "").trim();
  const index = Number(text) - 1;
  const reasonCode = REASON_CODES[index];
  if (!reasonCode) {
    await deps.sender.sendMessage(chatId, buildInvalidReasonReply());
    return { outcome: "invalid_input" };
  }

  const draft = (state.draftState as unknown as DraftState) ?? {};
  draft.reasonCode = reasonCode;

  if (reasonCode === "OTHER_REQUIRES_NOTE") {
    await deps.repository.setConversationState(identity.identityId, identity.companyId, {
      pendingDeliveryId: delivery.id,
      awaiting: "reason_note",
      currentItemIndex: 0,
      draftState: draft as unknown as Record<string, unknown>,
    });
    await deps.sender.sendMessage(chatId, buildAskReasonNoteReply());
    return { outcome: "reason_recorded", deliveryId: delivery.id };
  }

  await advanceToEvidence(chatId, identity, delivery.id, draft, deps);
  return { outcome: "reason_recorded", deliveryId: delivery.id };
}

async function handleReasonNote(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  delivery: { id: string },
  state: DeliveryConversationState,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const text = (message.text ?? "").trim();
  if (!validateReasonNote("OTHER_REQUIRES_NOTE", text)) {
    await deps.sender.sendMessage(chatId, buildAskReasonNoteReply());
    return { outcome: "invalid_input" };
  }

  const draft = (state.draftState as unknown as DraftState) ?? {};
  draft.reasonNote = text;
  await advanceToEvidence(chatId, identity, delivery.id, draft, deps);
  return { outcome: "reason_note_recorded", deliveryId: delivery.id };
}

async function advanceToEvidence(
  chatId: number,
  identity: ResolvedIdentity,
  deliveryId: string,
  draft: DraftState,
  deps: DeliveryWorkflowDeps
): Promise<void> {
  draft.evidenceTypes = draft.evidenceTypes ?? [];
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: deliveryId,
    awaiting: "evidence",
    currentItemIndex: 0,
    draftState: draft as unknown as Record<string, unknown>,
  });
  const req = evidenceRequirementFor(draft.outcome!);
  const missing = validateEvidence({
    outcome: draft.outcome!,
    evidenceTypes: draft.evidenceTypes,
    hasRecipient: draft.hasRecipient ?? false,
    hasLocation: draft.hasLocation ?? false,
    reasonCode: draft.reasonCode ?? null,
  }).missing;
  if (missing.length === 0 && req.requiredTypes.length === 0 && !req.requireRecipient) {
    await moveToPreview(chatId, identity, deliveryId, draft, deps);
    return;
  }
  await deps.sender.sendMessage(chatId, buildAskEvidenceReply(missing));
}

async function handleEvidence(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  delivery: { id: string },
  state: DeliveryConversationState,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const draft = (state.draftState as unknown as DraftState) ?? {};
  draft.evidenceTypes = draft.evidenceTypes ?? [];
  const req = evidenceRequirementFor(draft.outcome!);

  let recorded = false;

  const photo = message.photo?.[message.photo.length - 1];
  const document = message.document;
  if (photo || document) {
    const storageRef = photo?.file_id ?? document!.file_id;
    const wantsPhoto = req.requiredTypes.includes("photo") && !draft.evidenceTypes.includes("photo");
    const evidenceType = wantsPhoto ? "photo" : "signature";
    await deps.repository.insertEvidence(
      identity.companyId,
      delivery.id,
      { evidenceType, storageRef, metadata: photo ? { width: photo.width, height: photo.height } : {} },
      identity.userId
    );
    if (!draft.evidenceTypes.includes(evidenceType)) draft.evidenceTypes.push(evidenceType);
    recorded = true;
  } else if (message.location) {
    await deps.repository.insertEvidence(
      identity.companyId,
      delivery.id,
      {
        evidenceType: "location",
        storageRef: `${message.location.latitude},${message.location.longitude}`,
        latitude: message.location.latitude,
        longitude: message.location.longitude,
      },
      identity.userId
    );
    draft.hasLocation = true;
    draft.location = message.location;
    recorded = true;
  } else if (message.voice) {
    await deps.repository.insertEvidence(
      identity.companyId,
      delivery.id,
      { evidenceType: "voice_note", storageRef: message.voice.file_id, metadata: { duration: message.voice.duration } },
      identity.userId
    );
    if (!draft.evidenceTypes.includes("voice_note")) draft.evidenceTypes.push("voice_note");
    recorded = true;
  } else if (message.text && req.requireRecipient && !draft.hasRecipient) {
    draft.hasRecipient = true;
    draft.recipientName = message.text.trim();
    recorded = true;
  }

  if (!recorded) {
    const missing = validateEvidence({
      outcome: draft.outcome!,
      evidenceTypes: draft.evidenceTypes,
      hasRecipient: draft.hasRecipient ?? false,
      hasLocation: draft.hasLocation ?? false,
      reasonCode: draft.reasonCode ?? null,
    }).missing;
    await deps.sender.sendMessage(chatId, buildAskEvidenceReply(missing));
    return { outcome: "invalid_input" };
  }

  const missing = validateEvidence({
    outcome: draft.outcome!,
    evidenceTypes: draft.evidenceTypes,
    hasRecipient: draft.hasRecipient ?? false,
    hasLocation: draft.hasLocation ?? false,
    reasonCode: draft.reasonCode ?? null,
  }).missing;

  if (missing.length === 0) {
    await moveToPreview(chatId, identity, delivery.id, draft, deps);
    return { outcome: "evidence_recorded", deliveryId: delivery.id };
  }

  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: delivery.id,
    awaiting: "evidence",
    currentItemIndex: 0,
    draftState: draft as unknown as Record<string, unknown>,
  });
  await deps.sender.sendMessage(chatId, buildAskEvidenceReply(missing));
  return { outcome: "evidence_recorded", deliveryId: delivery.id };
}

async function moveToPreview(
  chatId: number,
  identity: ResolvedIdentity,
  deliveryId: string,
  draft: DraftState,
  deps: DeliveryWorkflowDeps
): Promise<void> {
  await deps.repository.setConversationState(identity.identityId, identity.companyId, {
    pendingDeliveryId: deliveryId,
    awaiting: "final_confirmation",
    currentItemIndex: 0,
    draftState: draft as unknown as Record<string, unknown>,
  });

  const delivery = await deps.repository.getDelivery(deliveryId);
  if (!delivery) return;

  const previewItems = delivery.items.map((item) => {
    const o = draft.itemOutcomes?.[item.id];
    return o ? { ...item, receivedQuantity: o.receivedQuantity } : item;
  });
  const discrepancies = computeDiscrepancies({ ...delivery, items: previewItems });
  const eligibility = computeInvoiceEligibility({ ...delivery, items: previewItems });
  await deps.sender.sendMessage(chatId, buildReconciliationPreview({ ...delivery, items: previewItems }, discrepancies, eligibility));
}

async function handleFinalConfirmation(
  message: NonNullable<TelegramUpdate["message"]>,
  chatId: number,
  identity: ResolvedIdentity,
  delivery: DeliveryRecord,
  state: DeliveryConversationState,
  telegramUpdateEventId: string,
  deps: DeliveryWorkflowDeps
): Promise<DeliveryProcessResult> {
  const text = (message.text ?? "").trim().toUpperCase();
  if (text !== CONFIRM_DELIVERY_KEYWORD) {
    await deps.sender.sendMessage(chatId, `Balas "${CONFIRM_DELIVERY_KEYWORD}" untuk mengunci hasil, atau tunggu instruksi lebih lanjut.`);
    return { outcome: "invalid_input" };
  }

  const draft = (state.draftState as unknown as DraftState) ?? {};
  const outcome = draft.outcome!;
  const finalStatus = mapOutcomeToFinalStatus(outcome);

  // Idempotent: bila sudah terminal sebelumnya (retry/double-tap), tidak mengubah apa pun lagi.
  const existing = await deps.repository.getDelivery(delivery.id);
  const alreadyTerminal = existing && existing.status !== "arrived" && existing.status !== "dispatched" && existing.status !== "planned";
  if (alreadyTerminal) {
    await deps.sender.sendMessage(chatId, buildAlreadyFinalizedReply());
    return { outcome: "finalized", deliveryId: delivery.id, alreadyFinalized: true, finalStatus: existing!.status };
  }

  // Satu-satunya jalur commit quantity: atomic, row-locked lintas SELURUH
  // delivery attempt milik sales_order yang sama. Menolak (TIDAK silent
  // clamp) bila kombinasi ini akan mendorong SUM received_quantity melebihi
  // ordered_quantity -- termasuk kasus dua attempt confirm hampir bersamaan.
  const itemOutcomeEntries = Object.entries(draft.itemOutcomes ?? {});
  if (itemOutcomeEntries.length > 0) {
    const result = await deps.repository.finalizeItemQuantities(
      delivery.id,
      itemOutcomeEntries.map(([itemId, o]) => ({ deliveryItemId: itemId, ...o }))
    );
    if (!result.ok) {
      await deps.sender.sendMessage(
        chatId,
        buildQuantityConflictReply(result.error.salesOrderItemId, result.error.outstanding, result.error.requested)
      );
      // TIDAK finalize, TIDAK insert exception/recipient/alert, TIDAK sync
      // lifecycle -- state tetap final_confirmation, delivery tetap belum
      // terminal. Driver/admin perlu menindaklanjuti secara manual.
      return { outcome: "quantity_conflict", deliveryId: delivery.id };
    }
  }

  if (draft.reasonCode) {
    const finalDeliverySnapshot = await deps.repository.getDelivery(delivery.id);
    const eligibilityForSeverity = computeInvoiceEligibility(finalDeliverySnapshot ?? delivery);
    await deps.repository.insertException(
      identity.companyId,
      delivery.id,
      {
        reasonCode: draft.reasonCode,
        note: draft.reasonNote ?? null,
        severity: computeExceptionSeverity(outcome, eligibilityForSeverity),
      },
      identity.userId
    );
  }

  if (draft.hasRecipient && draft.recipientName) {
    // DV-05: bandingkan dengan penerima attempt sebelumnya (bila ada) untuk
    // mendeteksi pergantian PIC — bukan diblokir otomatis, hanya dicatat.
    const previousRecipient = await deps.repository.getPreviousRecipientName(delivery.salesOrderId, delivery.attemptNumber);
    const isExpectedPic = previousRecipient === null || previousRecipient.trim().toLowerCase() === draft.recipientName.trim().toLowerCase();
    await deps.repository.insertRecipient(identity.companyId, delivery.id, {
      recipientName: draft.recipientName,
      isExpectedPic,
      identityNote: null,
      signatureEvidenceId: null,
    });
    if (!isExpectedPic) {
      await deps.repository.insertEvent({
        companyId: identity.companyId,
        deliveryId: delivery.id,
        eventType: "recipient_changed",
        fromStatus: null,
        toStatus: null,
        actorId: identity.userId,
        telegramUpdateEventId,
        payload: { previousRecipient, newRecipient: draft.recipientName },
      });
    }
  }

  const { delivery: finalized, alreadyFinalized } = await deps.repository.finalizeDelivery(delivery.id, finalStatus);

  await deps.repository.insertEvent({
    companyId: identity.companyId,
    deliveryId: delivery.id,
    eventType: "finalized",
    fromStatus: delivery.status,
    toStatus: finalStatus,
    actorId: identity.userId,
    telegramUpdateEventId,
    payload: { outcome },
  });

  if (!alreadyFinalized) {
    // Lifecycle agregat: hitung ulang dari total received_quantity lintas
    // seluruh delivery attempt milik order ini (idempoten, atomic — lihat
    // migration sync_sales_order_delivery_status). Hanya dipanggil sekali
    // per finalize sungguhan, retry KONFIRMASI KIRIM tidak memanggilnya lagi.
    await deps.repository.syncSalesOrderStatus(delivery.salesOrderId);
  }

  const invoiceEligibility = computeInvoiceEligibility(finalized);
  if (!alreadyFinalized && requiresOwnerAlert(finalStatus, invoiceEligibility, finalized.exceptions)) {
    const evidenceSummary = (draft.evidenceTypes ?? []).join(", ") || "tidak ada";
    const payload = buildOwnerAlertPayload({
      customerName: "(lihat detail order)",
      orderReference: delivery.salesOrderId,
      finalStatus,
      invoiceEligibility,
      reason: draft.reasonCode ?? "-",
      evidenceSummary,
      actor: identity.userFullName,
    });
    await deps.repository.insertOwnerAlert({
      companyId: identity.companyId,
      salesOrderId: delivery.salesOrderId,
      deliveryId: delivery.id,
      alertType: "delivery_variance",
      channel: "whatsapp",
      severity: computeExceptionSeverity(outcome, invoiceEligibility),
      payload,
    });
  }

  // Awaiting TETAP final_confirmation (bukan direset ke none) supaya retry
  // KONFIRMASI KIRIM berikutnya jatuh ke cabang idempotent di atas, mirror
  // pola sales-orders/workflow.ts confirmOrder().
  await deps.sender.sendMessage(chatId, buildFinalConfirmedReply(outcome));
  return { outcome: "finalized", deliveryId: delivery.id, alreadyFinalized, finalStatus };
}
