// =============================================================================
// Workflow — orkestrator percakapan Telegram "Batalkan atau Sengketakan
// Order" + integrasi owner alert (mechanism existing).
// =============================================================================

import type { TelegramSender } from "@/lib/telegram/client";
import type { OrderDisputeRepository } from "./repository";
import {
  type DisputeConversationRepository,
  type DisputeConversationState,
  detectDisputeTrigger,
  parseNumberedChoice,
} from "./conversation";
import { REASON_CODES, type OrderStage, type RequestType } from "./types";
import { overrideDispatchPlan } from "@/lib/dispatch/workflow";
import type { DispatchRepositoryInterface } from "@/lib/dispatch/repository";
import type { DeliveryRepositoryInterface } from "@/lib/delivery/repository";
import {
  buildOrderNotFoundReply,
  buildOrderAlreadyCancelledReply,
  buildAlreadyHasActiveRequestReply,
  buildOrderSummaryAndTypePrompt,
  buildInvalidChoiceReply,
  buildAskPicNamePrompt,
  buildAskContactSourcePrompt,
  buildAskReasonPrompt,
  buildAskNotesPrompt,
  buildFinalConfirmationPrompt,
  buildProcessCancelledReply,
  buildRequestCreatedReply,
  buildUnexpectedErrorReply,
  contactSourceFromChoice,
} from "./confirmation";
import { requiresOwnerAlertForDispute, buildDisputeAlertPayload } from "./service";

export interface ResolvedDisputeIdentity {
  identityId: string;
  companyId: string;
  userId: string;
}

export interface OrderDisputeWorkflowDeps {
  repository: OrderDisputeRepository;
  conversationRepository: DisputeConversationRepository;
  sender: TelegramSender;
  /**
   * Opsional -- kalau tersedia, dipakai untuk mengecualikan order dari
   * dispatch plan aktif (overrideDispatchPlan "hold", mekanisme existing)
   * saat request dibuat pada tahap IN_DISPATCH_PLAN_NOT_DEPARTED. Kalau
   * tidak disuntik (mis. test yang tidak menguji sisi dispatch), langkah
   * ini di-skip dengan aman -- request dispute tetap tercatat.
   */
  dispatchRepository?: DispatchRepositoryInterface;
  /**
   * Opsional -- kalau tersedia, dipakai untuk mencatat delivery exception
   * (insertException, mekanisme existing) saat order sudah berangkat/sebagian-
   * /seluruh diterima ketika request cancel/dispute dibuat -- supaya barang
   * tidak diserahkan lagi dan bukti pengiriman yang sudah ada tidak terhapus.
   */
  deliveryRepository?: DeliveryRepositoryInterface;
}

export type DisputeProcessResult =
  | { outcome: "not_dispute_command" }
  | { outcome: "order_lookup_failed" }
  | { outcome: "awaiting_type_selection" }
  | { outcome: "awaiting_pic_name" }
  | { outcome: "awaiting_contact_source" }
  | { outcome: "awaiting_reason_selection" }
  | { outcome: "awaiting_notes" }
  | { outcome: "awaiting_final_confirmation" }
  | { outcome: "cancelled_by_user" }
  | { outcome: "request_created"; requestId: string; autoCancelled: boolean }
  | { outcome: "request_already_exists"; requestId: string }
  | { outcome: "rejected"; reason: string };

const RESET_STATE: DisputeConversationState = { awaiting: "none", pendingSalesOrderId: null, draft: {} };

/**
 * Entry point tunggal untuk pesan Telegram dari Salesman terkait
 * Batalkan/Sengketakan Order. Dipanggil dari route webhook SETELAH identity
 * di-resolve server-side (identity/company TIDAK PERNAH dari payload).
 */
export async function processDisputeMessage(
  text: string,
  chatId: number,
  identity: ResolvedDisputeIdentity,
  deps: OrderDisputeWorkflowDeps
): Promise<DisputeProcessResult> {
  const state = await deps.conversationRepository.getState(identity.identityId);

  if (state.awaiting === "none") {
    const { isTrigger, orderNumber } = detectDisputeTrigger(text);
    if (!isTrigger || !orderNumber) return { outcome: "not_dispute_command" };

    const order = await deps.repository.findOrderByNumber(identity.companyId, orderNumber);
    if (!order) {
      await deps.sender.sendMessage(chatId, buildOrderNotFoundReply());
      return { outcome: "order_lookup_failed" };
    }
    if (order.status === "cancelled") {
      await deps.sender.sendMessage(chatId, buildOrderAlreadyCancelledReply());
      return { outcome: "order_lookup_failed" };
    }

    await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
      awaiting: "type_selection",
      pendingSalesOrderId: order.id,
      draft: {
        conversationStartedAt: new Date().toISOString(),
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        customerId: order.customerId,
        finalAmount: order.finalAmount,
      },
    });
    await deps.sender.sendMessage(chatId, buildOrderSummaryAndTypePrompt(order));
    return { outcome: "awaiting_type_selection" };
  }

  if (text.trim().toUpperCase() === "BATAL") {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildProcessCancelledReply());
    return { outcome: "cancelled_by_user" };
  }

  switch (state.awaiting) {
    case "type_selection": {
      const choice = parseNumberedChoice(text, 2);
      if (!choice) {
        await deps.sender.sendMessage(chatId, buildInvalidChoiceReply(2));
        return { outcome: "awaiting_type_selection" };
      }
      const requestType = choice === 1 ? "CUSTOMER_CANCELLED" : "CUSTOMER_DENIES_ORDER";
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "pic_name",
        draft: { ...state.draft, requestType },
      });
      await deps.sender.sendMessage(chatId, buildAskPicNamePrompt());
      return { outcome: "awaiting_pic_name" };
    }

    case "pic_name": {
      const picName = text.trim();
      if (picName.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskPicNamePrompt());
        return { outcome: "awaiting_pic_name" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "contact_source",
        draft: { ...state.draft, picName },
      });
      await deps.sender.sendMessage(chatId, buildAskContactSourcePrompt());
      return { outcome: "awaiting_contact_source" };
    }

    case "contact_source": {
      const choice = parseNumberedChoice(text, 4);
      const contactSource = choice ? contactSourceFromChoice(choice) : null;
      if (!contactSource) {
        await deps.sender.sendMessage(chatId, buildInvalidChoiceReply(4));
        return { outcome: "awaiting_contact_source" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "reason_selection",
        draft: { ...state.draft, contactSource },
      });
      await deps.sender.sendMessage(chatId, buildAskReasonPrompt());
      return { outcome: "awaiting_reason_selection" };
    }

    case "reason_selection": {
      const choice = parseNumberedChoice(text, REASON_CODES.length);
      if (!choice) {
        await deps.sender.sendMessage(chatId, buildInvalidChoiceReply(REASON_CODES.length));
        return { outcome: "awaiting_reason_selection" };
      }
      const reasonCode = REASON_CODES[choice - 1]!;
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "notes",
        draft: { ...state.draft, reasonCode },
      });
      await deps.sender.sendMessage(chatId, buildAskNotesPrompt());
      return { outcome: "awaiting_notes" };
    }

    case "notes": {
      const notes = text.trim() === "-" ? null : text.trim();
      const nextDraft = { ...state.draft, notes };
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "final_confirmation",
        draft: nextDraft,
      });
      await deps.sender.sendMessage(
        chatId,
        buildFinalConfirmationPrompt(
          {
            id: state.pendingSalesOrderId!,
            orderNumber: nextDraft.orderNumber ?? "",
            status: "",
            customerId: nextDraft.customerId ?? null,
            customerName: nextDraft.customerName ?? "",
            finalAmount: nextDraft.finalAmount ?? 0,
          },
          nextDraft
        )
      );
      return { outcome: "awaiting_final_confirmation" };
    }

    case "final_confirmation": {
      if (text.trim().toUpperCase() !== "KONFIRMASI") {
        return { outcome: "awaiting_final_confirmation" };
      }
      return await finalizeDisputeRequest(identity, chatId, state, deps);
    }

    default:
      return { outcome: "not_dispute_command" };
  }
}

async function finalizeDisputeRequest(
  identity: ResolvedDisputeIdentity,
  chatId: number,
  state: DisputeConversationState,
  deps: OrderDisputeWorkflowDeps
): Promise<DisputeProcessResult> {
  if (!state.pendingSalesOrderId || !state.draft.requestType || !state.draft.contactSource || !state.draft.reasonCode) {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
    return { outcome: "rejected", reason: "incomplete_draft" };
  }

  const salesOrderId = state.pendingSalesOrderId;
  const idempotencyKey = `${identity.identityId}:${salesOrderId}:${state.draft.conversationStartedAt ?? ""}`;

  const result = await deps.repository.createRequest({
    companyId: identity.companyId,
    salesOrderId,
    requestType: state.draft.requestType,
    reasonCode: state.draft.reasonCode,
    notes: state.draft.notes ?? null,
    reportedPicName: state.draft.picName ?? null,
    reportedPicPhone: null,
    contactSource: state.draft.contactSource,
    requestedBy: identity.userId,
    idempotencyKey,
  });

  const draftSnapshot = state.draft;
  await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);

  if (result.outcome === "created" || result.outcome === "already_exists") {
    await deps.sender.sendMessage(
      chatId,
      buildRequestCreatedReply({
        autoCancelled: result.autoCancelled,
        aiClassification: result.aiClassification,
        requestType: draftSnapshot.requestType!,
      })
    );

    if (result.outcome === "created" && !result.autoCancelled) {
      await applyDispatchHoldIfNeeded(identity, salesOrderId, result.orderStage, result.requestId, deps);
      await applyDeliveryExceptionIfNeeded(
        identity,
        salesOrderId,
        result.orderStage,
        draftSnapshot.requestType!,
        result.requestId,
        deps
      );
      await triggerOwnerAlertIfNeeded(identity, draftSnapshot, salesOrderId, result, deps);
    }

    return result.outcome === "created"
      ? { outcome: "request_created", requestId: result.requestId, autoCancelled: result.autoCancelled }
      : { outcome: "request_already_exists", requestId: result.requestId };
  }

  if (result.outcome === "already_has_active_request") {
    await deps.sender.sendMessage(chatId, buildAlreadyHasActiveRequestReply());
    return { outcome: "rejected", reason: "already_has_active_request" };
  }
  if (result.outcome === "order_already_cancelled") {
    await deps.sender.sendMessage(chatId, buildOrderAlreadyCancelledReply());
    return { outcome: "rejected", reason: "order_already_cancelled" };
  }

  await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
  return { outcome: "rejected", reason: result.outcome };
}

/**
 * Order yang masih di dispatch plan aktif (belum berangkat) harus dikecualikan
 * dari proses dispatch selama request cancel/dispute berjalan -- pakai
 * overrideDispatchPlan "hold" yang SUDAH ADA (dispatch/workflow.ts), bukan
 * membuat mekanisme baru. Riwayat plan tetap utuh (audit event human_override),
 * replan lanjutan tetap lewat mekanisme override yang sama setelah review.
 */
async function applyDispatchHoldIfNeeded(
  identity: ResolvedDisputeIdentity,
  salesOrderId: string,
  orderStage: OrderStage,
  requestId: string,
  deps: OrderDisputeWorkflowDeps
): Promise<void> {
  if (orderStage !== "IN_DISPATCH_PLAN_NOT_DEPARTED") return;
  if (!deps.dispatchRepository) return;

  const plan = await deps.dispatchRepository.findPlanBySalesOrder(identity.companyId, salesOrderId);
  if (!plan) return;
  if (plan.planningStatus === "cancelled" || plan.planningStatus === "manual_hold") return;

  await overrideDispatchPlan(
    identity.companyId,
    plan.id,
    {
      action: "hold",
      reason: `Order sedang dalam proses pembatalan/sengketa (request ${requestId}) -- dikecualikan dari dispatch aktif sampai direview.`,
      actorId: identity.userId,
    },
    { repository: deps.dispatchRepository }
  );
}

/** Tahap di mana barang sudah bergerak keluar gudang -- perlu delivery exception, bukan dispatch-hold. */
const DELIVERY_EXCEPTION_STAGES: readonly OrderStage[] = ["DEPARTED_IN_TRANSIT", "RECEIVED_PARTIAL", "RECEIVED_FULL"];

/**
 * Order yang sudah berangkat/sebagian/seluruh diterima saat cancel/dispute
 * diajukan HARUS ditandai lewat insertException (mekanisme existing di
 * delivery module) supaya (a) barang tidak diserahkan lagi ke luar proses
 * verifikasi, (b) bukti pengiriman & receipt yang sudah terverifikasi TIDAK
 * dihapus/ditimpa -- exception murni menambah catatan, bukan mengubah status
 * delivery/item yang sudah final. Invoice eligibility tetap dihitung dari
 * receivedQuantity yang sudah ada (lihat computeAggregateInvoiceEligibility),
 * exception ini hanya flag untuk proses retur/disposisi sisa barang.
 */
async function applyDeliveryExceptionIfNeeded(
  identity: ResolvedDisputeIdentity,
  salesOrderId: string,
  orderStage: OrderStage,
  requestType: RequestType,
  requestId: string,
  deps: OrderDisputeWorkflowDeps
): Promise<void> {
  if (!DELIVERY_EXCEPTION_STAGES.includes(orderStage)) return;
  if (!deps.deliveryRepository) return;

  const delivery = await deps.deliveryRepository.getLatestDeliveryForOrder(salesOrderId);
  if (!delivery || delivery.companyId !== identity.companyId) return;

  const alreadyFlagged = delivery.exceptions.some((e) => e.note?.includes(requestId));
  if (alreadyFlagged) return;

  const typeLabel =
    requestType === "CUSTOMER_DENIES_ORDER" ? "PIC menyatakan tidak pernah memesan" : "PIC membatalkan pesanan";

  await deps.deliveryRepository.insertException(
    identity.companyId,
    delivery.id,
    {
      reasonCode: "OTHER_REQUIRES_NOTE",
      note: `Order dalam proses pembatalan/sengketa (request ${requestId}): ${typeLabel}. Barang sudah berangkat/diterima -- jangan serahkan sisa barang, tunggu review admin/owner untuk keputusan retur/disposisi. Bukti pengiriman yang sudah ada tidak dihapus.`,
      severity: "high",
      deliveryItemId: null,
    },
    identity.userId
  );
}

async function triggerOwnerAlertIfNeeded(
  identity: ResolvedDisputeIdentity,
  draft: DisputeConversationState["draft"],
  salesOrderId: string,
  result: { requestId: string; orderStage: OrderStage },
  deps: OrderDisputeWorkflowDeps
): Promise<void> {
  const requestType = draft.requestType!;
  const orderStage = result.orderStage;

  const threshold = await deps.repository.getHighValueThreshold(identity.companyId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const recentCount = draft.customerId
    ? await deps.repository.countRecentDisputesForCustomer(identity.companyId, draft.customerId, since)
    : 0;

  const shouldAlert = requiresOwnerAlertForDispute({
    requestType,
    orderStage,
    orderValue: draft.finalAmount ?? 0,
    highValueThreshold: threshold,
    recentDisputeCountForCustomer: recentCount,
    picChangedDuringDispute: false,
  });

  if (!shouldAlert) return;

  const payload = buildDisputeAlertPayload({
    requestType,
    orderReference: draft.orderNumber ?? "",
    customerName: draft.customerName ?? "",
    orderStage,
    reasonCode: draft.reasonCode ?? "",
    reportedPicName: draft.picName ?? null,
    contactSource: draft.contactSource ?? "OTHER",
    actor: identity.userId,
  });

  await deps.repository.createOwnerAlert({
    companyId: identity.companyId,
    salesOrderId,
    alertType: requestType === "CUSTOMER_DENIES_ORDER" ? "order_dispute_denies_order" : "order_cancellation_after_dispatch",
    severity: requestType === "CUSTOMER_DENIES_ORDER" ? "high" : "medium",
    payload: payload as unknown as Record<string, unknown>,
  });
}
