// =============================================================================
// Workflow — orkestrator percakapan Telegram "Tambah Toko" DAN "Tambah PIC"
// (PIC kedua dan seterusnya ke toko yang sudah ada). Kedua alur berbagi satu
// tabel conversation state (store_pic_conversation_state) dan satu entry
// point (processAddStoreMessage), persis seperti order-disputes/workflow.ts:
// identity di-resolve server-side, conversation state tenant-scoped dengan
// expiry (lihat conversation.ts).
// =============================================================================

import type { TelegramSender } from "@/lib/telegram/client";
import type { CustomerPicRepository } from "./repository";
import {
  type StorePicConversationRepository,
  type StorePicConversationState,
  type StorePicDraft,
  detectAddStoreTrigger,
  detectAddPicTrigger,
  parseNumberedChoice,
  parseMultipleChoices,
} from "./conversation";
import { PIC_ROLES, type PicRole } from "./types";
import { normalizeEmail, isValidEmailFormat } from "./email";
import {
  buildNoAssignedAreaReply,
  buildAskStoreNamePrompt,
  buildAskStoreAddressPrompt,
  buildAskStoreAreaPrompt,
  buildInvalidChoiceReply,
  buildAskStorePhonePrompt,
  buildAskPicNamePrompt,
  buildAskPicPhonePrompt,
  buildAskPicEmailPrompt,
  buildInvalidEmailReply,
  buildAskPicRolesPrompt,
  buildInvalidMultiChoiceReply,
  buildFinalConfirmationPrompt,
  buildProcessCancelledReply,
  buildExactDuplicateReply,
  buildSimilarDuplicateWarningPrompt,
  buildStoreCreatedReply,
  buildUnexpectedErrorReply,
  buildAskStoreSearchPrompt,
  buildStoreSearchNoResultsPrompt,
  buildStoreSearchMultipleResultsPrompt,
  buildStoreFoundConfirmPrompt,
  buildAddPicFinalConfirmationPrompt,
  buildAddPicCreatedReply,
  buildPhoneExistsOnStoreReply,
} from "./confirmation";

export interface ResolvedStorePicIdentity {
  identityId: string;
  companyId: string;
  userId: string;
}

export interface StorePicWorkflowDeps {
  repository: CustomerPicRepository;
  conversationRepository: StorePicConversationRepository;
  sender: TelegramSender;
}

export type AddStoreProcessResult =
  | { outcome: "not_relevant" }
  | { outcome: "no_assigned_area" }
  | { outcome: "awaiting_store_name" }
  | { outcome: "awaiting_store_address" }
  | { outcome: "awaiting_store_area" }
  | { outcome: "awaiting_store_phone" }
  | { outcome: "awaiting_pic_name" }
  | { outcome: "awaiting_pic_phone" }
  | { outcome: "awaiting_pic_email" }
  | { outcome: "awaiting_pic_roles" }
  | { outcome: "awaiting_final_confirmation" }
  | { outcome: "awaiting_similar_duplicate_confirmation" }
  | { outcome: "cancelled_by_user" }
  | { outcome: "store_created"; customerId: string; customerPicId: string }
  | { outcome: "exact_duplicate_redirected"; duplicateCustomerId: string }
  // -- Tambah PIC --
  | { outcome: "awaiting_add_pic_store_search" }
  | { outcome: "awaiting_add_pic_store_select" }
  | { outcome: "awaiting_add_pic_name" }
  | { outcome: "awaiting_add_pic_phone" }
  | { outcome: "awaiting_add_pic_email" }
  | { outcome: "awaiting_add_pic_roles" }
  | { outcome: "awaiting_add_pic_confirm" }
  | { outcome: "pic_created"; customerId: string; customerPicId: string }
  | { outcome: "pic_phone_exists_on_store"; existingCustomerPicId: string }
  | { outcome: "rejected"; reason: string };

const RESET_STATE: StorePicConversationState = { awaiting: "none", draft: {} };
const AUTO_OVERRIDE_REASON = "Dikonfirmasi oleh Salesman via Telegram sebagai toko berbeda.";

export async function processAddStoreMessage(
  text: string,
  chatId: number,
  identity: ResolvedStorePicIdentity,
  deps: StorePicWorkflowDeps
): Promise<AddStoreProcessResult> {
  const state = await deps.conversationRepository.getState(identity.identityId);

  if (state.awaiting === "none") {
    if (detectAddStoreTrigger(text)) return startAddStore(chatId, identity, deps);
    if (detectAddPicTrigger(text)) return startAddPic(chatId, identity, deps);
    return { outcome: "not_relevant" };
  }

  if (text.trim().toUpperCase() === "BATAL") {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildProcessCancelledReply());
    return { outcome: "cancelled_by_user" };
  }

  switch (state.awaiting) {
    case "store_name": {
      const storeName = text.trim();
      if (storeName.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskStoreNamePrompt());
        return { outcome: "awaiting_store_name" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "store_address",
        draft: { ...state.draft, storeName },
      });
      await deps.sender.sendMessage(chatId, buildAskStoreAddressPrompt());
      return { outcome: "awaiting_store_address" };
    }

    case "store_address": {
      const storeAddress = text.trim() === "-" ? undefined : text.trim();
      const areas = await deps.repository.getSalesmanCoverageAreas(identity.companyId, identity.userId);
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "store_area",
        draft: { ...state.draft, storeAddress },
      });
      await deps.sender.sendMessage(chatId, buildAskStoreAreaPrompt(areas));
      return { outcome: "awaiting_store_area" };
    }

    case "store_area": {
      const areas = await deps.repository.getSalesmanCoverageAreas(identity.companyId, identity.userId);
      const choice = parseNumberedChoice(text, areas.length);
      if (!choice) {
        await deps.sender.sendMessage(chatId, buildInvalidChoiceReply(areas.length));
        return { outcome: "awaiting_store_area" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "store_phone",
        draft: { ...state.draft, storeArea: areas[choice - 1] },
      });
      await deps.sender.sendMessage(chatId, buildAskStorePhonePrompt());
      return { outcome: "awaiting_store_phone" };
    }

    case "store_phone": {
      const storePhone = text.trim() === "-" ? undefined : text.trim();
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "pic_name",
        draft: { ...state.draft, storePhone },
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
        awaiting: "pic_phone",
        draft: { ...state.draft, picName },
      });
      await deps.sender.sendMessage(chatId, buildAskPicPhonePrompt());
      return { outcome: "awaiting_pic_phone" };
    }

    case "pic_phone": {
      const picPhone = text.trim();
      if (picPhone.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskPicPhonePrompt());
        return { outcome: "awaiting_pic_phone" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "pic_email",
        draft: { ...state.draft, picPhone },
      });
      await deps.sender.sendMessage(chatId, buildAskPicEmailPrompt());
      return { outcome: "awaiting_pic_email" };
    }

    case "pic_email": {
      const raw = text.trim();
      if (raw !== "-") {
        const normalized = normalizeEmail(raw);
        if (normalized !== null && !isValidEmailFormat(normalized)) {
          await deps.sender.sendMessage(chatId, buildInvalidEmailReply());
          return { outcome: "awaiting_pic_email" };
        }
      }
      const picEmail = raw === "-" ? undefined : raw;
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "pic_roles",
        draft: { ...state.draft, picEmail },
      });
      await deps.sender.sendMessage(chatId, buildAskPicRolesPrompt());
      return { outcome: "awaiting_pic_roles" };
    }

    case "pic_roles": {
      const choices = parseMultipleChoices(text, PIC_ROLES.length);
      if (!choices) {
        await deps.sender.sendMessage(chatId, buildInvalidMultiChoiceReply(PIC_ROLES.length));
        return { outcome: "awaiting_pic_roles" };
      }
      const picRoles: PicRole[] = choices.map((c) => PIC_ROLES[c - 1]!);
      const nextDraft = { ...state.draft, picRoles };
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "final_confirmation",
        draft: nextDraft,
      });
      await deps.sender.sendMessage(chatId, buildFinalConfirmationPrompt(nextDraft));
      return { outcome: "awaiting_final_confirmation" };
    }

    case "final_confirmation": {
      const upper = text.trim().toUpperCase();
      if (upper === "UBAH") {
        await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
          awaiting: "store_name",
          draft: { conversationStartedAt: state.draft.conversationStartedAt },
        });
        await deps.sender.sendMessage(chatId, buildAskStoreNamePrompt());
        return { outcome: "awaiting_store_name" };
      }
      if (upper !== "KONFIRMASI") {
        return { outcome: "awaiting_final_confirmation" };
      }
      return await finalizeAddStore(identity, chatId, state.draft, false, deps);
    }

    case "similar_duplicate_confirmation": {
      const upper = text.trim().toUpperCase();
      if (upper !== "KONFIRMASI") {
        await deps.sender.sendMessage(chatId, buildSimilarDuplicateWarningPrompt(state.draft.similarDuplicateStoreName ?? "-"));
        return { outcome: "awaiting_similar_duplicate_confirmation" };
      }
      return await finalizeAddStore(identity, chatId, state.draft, true, deps);
    }

    // -----------------------------------------------------------------
    // Tambah PIC
    // -----------------------------------------------------------------

    case "add_pic_store_search": {
      const query = text.trim();
      if (query.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskStoreSearchPrompt());
        return { outcome: "awaiting_add_pic_store_search" };
      }
      const results = await deps.repository.searchStoresForSalesman(identity.companyId, identity.userId, query);
      if (results.length === 0) {
        await deps.sender.sendMessage(chatId, buildStoreSearchNoResultsPrompt());
        return { outcome: "awaiting_add_pic_store_search" };
      }
      if (results.length === 1) {
        const store = results[0]!;
        await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
          ...state,
          awaiting: "add_pic_name",
          draft: { ...state.draft, addPicSelectedCustomerId: store.id, addPicSelectedStoreName: store.name },
        });
        await deps.sender.sendMessage(chatId, buildStoreFoundConfirmPrompt(store.name));
        return { outcome: "awaiting_add_pic_name" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_store_select",
        draft: { ...state.draft, addPicSearchResults: results },
      });
      await deps.sender.sendMessage(chatId, buildStoreSearchMultipleResultsPrompt(results));
      return { outcome: "awaiting_add_pic_store_select" };
    }

    case "add_pic_store_select": {
      const results = state.draft.addPicSearchResults ?? [];
      const choice = parseNumberedChoice(text, results.length);
      if (!choice) {
        await deps.sender.sendMessage(chatId, buildInvalidChoiceReply(results.length));
        return { outcome: "awaiting_add_pic_store_select" };
      }
      const store = results[choice - 1]!;
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_name",
        draft: { ...state.draft, addPicSelectedCustomerId: store.id, addPicSelectedStoreName: store.name, addPicSearchResults: undefined },
      });
      await deps.sender.sendMessage(chatId, buildStoreFoundConfirmPrompt(store.name));
      return { outcome: "awaiting_add_pic_name" };
    }

    case "add_pic_name": {
      const addPicName = text.trim();
      if (addPicName.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskPicNamePrompt());
        return { outcome: "awaiting_add_pic_name" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_phone",
        draft: { ...state.draft, addPicName },
      });
      await deps.sender.sendMessage(chatId, buildAskPicPhonePrompt());
      return { outcome: "awaiting_add_pic_phone" };
    }

    case "add_pic_phone": {
      const addPicPhone = text.trim();
      if (addPicPhone.length === 0) {
        await deps.sender.sendMessage(chatId, buildAskPicPhonePrompt());
        return { outcome: "awaiting_add_pic_phone" };
      }
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_email",
        draft: { ...state.draft, addPicPhone },
      });
      await deps.sender.sendMessage(chatId, buildAskPicEmailPrompt());
      return { outcome: "awaiting_add_pic_email" };
    }

    case "add_pic_email": {
      const raw = text.trim();
      if (raw !== "-") {
        const normalized = normalizeEmail(raw);
        if (normalized !== null && !isValidEmailFormat(normalized)) {
          await deps.sender.sendMessage(chatId, buildInvalidEmailReply());
          return { outcome: "awaiting_add_pic_email" };
        }
      }
      const addPicEmail = raw === "-" ? undefined : raw;
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_roles",
        draft: { ...state.draft, addPicEmail },
      });
      await deps.sender.sendMessage(chatId, buildAskPicRolesPrompt());
      return { outcome: "awaiting_add_pic_roles" };
    }

    case "add_pic_roles": {
      const choices = parseMultipleChoices(text, PIC_ROLES.length);
      if (!choices) {
        await deps.sender.sendMessage(chatId, buildInvalidMultiChoiceReply(PIC_ROLES.length));
        return { outcome: "awaiting_add_pic_roles" };
      }
      const addPicRoles: PicRole[] = choices.map((c) => PIC_ROLES[c - 1]!);
      const nextDraft = { ...state.draft, addPicRoles };
      await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
        ...state,
        awaiting: "add_pic_confirm",
        draft: nextDraft,
      });
      await deps.sender.sendMessage(chatId, buildAddPicFinalConfirmationPrompt(nextDraft.addPicSelectedStoreName ?? "-", nextDraft));
      return { outcome: "awaiting_add_pic_confirm" };
    }

    case "add_pic_confirm": {
      const upper = text.trim().toUpperCase();
      if (upper === "UBAH") {
        await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
          awaiting: "add_pic_name",
          draft: {
            conversationStartedAt: state.draft.conversationStartedAt,
            addPicSelectedCustomerId: state.draft.addPicSelectedCustomerId,
            addPicSelectedStoreName: state.draft.addPicSelectedStoreName,
          },
        });
        await deps.sender.sendMessage(chatId, buildAskPicNamePrompt());
        return { outcome: "awaiting_add_pic_name" };
      }
      if (upper !== "KONFIRMASI") {
        return { outcome: "awaiting_add_pic_confirm" };
      }
      return await finalizeAddPic(identity, chatId, state.draft, deps);
    }

    default:
      return { outcome: "not_relevant" };
  }
}

async function startAddStore(
  chatId: number,
  identity: ResolvedStorePicIdentity,
  deps: StorePicWorkflowDeps
): Promise<AddStoreProcessResult> {
  const areas = await deps.repository.getSalesmanCoverageAreas(identity.companyId, identity.userId);
  if (areas.length === 0) {
    await deps.sender.sendMessage(chatId, buildNoAssignedAreaReply());
    return { outcome: "no_assigned_area" };
  }

  await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
    awaiting: "store_name",
    draft: { conversationStartedAt: new Date().toISOString() },
  });
  await deps.sender.sendMessage(chatId, buildAskStoreNamePrompt());
  return { outcome: "awaiting_store_name" };
}

async function startAddPic(
  chatId: number,
  identity: ResolvedStorePicIdentity,
  deps: StorePicWorkflowDeps
): Promise<AddStoreProcessResult> {
  await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
    awaiting: "add_pic_store_search",
    draft: { conversationStartedAt: new Date().toISOString() },
  });
  await deps.sender.sendMessage(chatId, buildAskStoreSearchPrompt());
  return { outcome: "awaiting_add_pic_store_search" };
}

async function finalizeAddStore(
  identity: ResolvedStorePicIdentity,
  chatId: number,
  draft: StorePicDraft,
  overrideSimilarDuplicate: boolean,
  deps: StorePicWorkflowDeps
): Promise<AddStoreProcessResult> {
  if (!draft.storeName || !draft.picName || !draft.picPhone || !draft.picRoles) {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
    return { outcome: "rejected", reason: "incomplete_draft" };
  }

  const idempotencyKey = `${identity.identityId}:${draft.conversationStartedAt ?? ""}`;

  const result = await deps.repository.createStoreWithPic({
    companyId: identity.companyId,
    actorId: identity.userId,
    storeName: draft.storeName,
    storePhone: draft.storePhone ?? null,
    storeAddress: draft.storeAddress ?? null,
    storeArea: draft.storeArea ?? null,
    storeLatitude: null,
    storeLongitude: null,
    assignedSalesId: identity.userId,
    picName: draft.picName,
    picPhone: draft.picPhone,
    picEmail: draft.picEmail ?? null,
    picRoles: draft.picRoles,
    idempotencyKey,
    source: "TELEGRAM_SALESMAN",
    overrideSimilarDuplicate,
    overrideReason: overrideSimilarDuplicate ? AUTO_OVERRIDE_REASON : null,
  });

  if (result.outcome === "created" || result.outcome === "already_exists") {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildStoreCreatedReply(draft.storeName, draft.picName));
    return { outcome: "store_created", customerId: result.customerId, customerPicId: result.customerPicId };
  }

  if (result.outcome === "exact_duplicate_store") {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    const existing = await deps.repository.getStoreSummary(identity.companyId, result.duplicateCustomerId);
    await deps.sender.sendMessage(chatId, buildExactDuplicateReply(existing?.name ?? "(toko existing)"));
    return { outcome: "exact_duplicate_redirected", duplicateCustomerId: result.duplicateCustomerId };
  }

  if (result.outcome === "similar_duplicate_warning") {
    const existing = await deps.repository.getStoreSummary(identity.companyId, result.duplicateCustomerId);
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, {
      awaiting: "similar_duplicate_confirmation",
      draft: {
        ...draft,
        similarDuplicateCustomerId: result.duplicateCustomerId,
        similarDuplicateStoreName: existing?.name ?? "(toko lain)",
      },
    });
    await deps.sender.sendMessage(chatId, buildSimilarDuplicateWarningPrompt(existing?.name ?? "(toko lain)"));
    return { outcome: "awaiting_similar_duplicate_confirmation" };
  }

  await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
  await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
  return { outcome: "rejected", reason: result.outcome };
}

async function finalizeAddPic(
  identity: ResolvedStorePicIdentity,
  chatId: number,
  draft: StorePicDraft,
  deps: StorePicWorkflowDeps
): Promise<AddStoreProcessResult> {
  if (!draft.addPicSelectedCustomerId || !draft.addPicName || !draft.addPicPhone || !draft.addPicRoles) {
    await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);
    await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
    return { outcome: "rejected", reason: "incomplete_draft" };
  }

  const idempotencyKey = `${identity.identityId}:add_pic:${draft.conversationStartedAt ?? ""}`;
  const storeName = draft.addPicSelectedStoreName ?? "(toko)";

  const result = await deps.repository.createCustomerPic({
    companyId: identity.companyId,
    customerId: draft.addPicSelectedCustomerId,
    actorId: identity.userId,
    name: draft.addPicName,
    phone: draft.addPicPhone,
    email: draft.addPicEmail ?? null,
    roles: draft.addPicRoles,
    idempotencyKey,
    source: "TELEGRAM_SALESMAN",
  });

  await deps.conversationRepository.setState(identity.identityId, identity.companyId, RESET_STATE);

  if (result.outcome === "created" || result.outcome === "already_exists") {
    await deps.sender.sendMessage(chatId, buildAddPicCreatedReply(storeName, draft.addPicName));
    return { outcome: "pic_created", customerId: draft.addPicSelectedCustomerId, customerPicId: result.customerPicId };
  }

  if (result.outcome === "phone_exists_on_store") {
    await deps.sender.sendMessage(chatId, buildPhoneExistsOnStoreReply());
    return { outcome: "pic_phone_exists_on_store", existingCustomerPicId: result.existingCustomerPicId };
  }

  await deps.sender.sendMessage(chatId, buildUnexpectedErrorReply());
  return { outcome: "rejected", reason: result.outcome };
}
