// =============================================================================
// Router Menu Utama Telegram -- Waluyo Daily Operating Loop. Dipanggil dari
// api/webhooks/telegram/route.ts SETELAH identity di-resolve server-side.
// Tidak pernah mempercayai company_id/salesman_id dari payload -- selalu dari
// ResolvedIdentity (lihat lib/sales-orders/repository.ts:resolveIdentity).
//
// Prioritas di dalam router ini sendiri: (1) trigger /start atau /menu selalu
// menampilkan ulang Menu Utama (reset flow apa pun yang sedang menggantung di
// tabel ini), (2) kalau sedang menunggu pilihan Menu Utama, proses pilihan
// tsb, (3) kalau tidak ada yang cocok, laporkan "not_menu_flow" supaya
// caller (route.ts) melanjutkan ke cascade berikutnya.
// =============================================================================

import type { TelegramSender } from "@/lib/telegram/client";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";
import type { DailySessionRepository } from "@/lib/daily-session/repository";
import type { AgendaRepository } from "@/lib/daily-session/agenda";
import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { CustomerPicRepository } from "@/lib/customer-pic/repository";
import type { StorePicConversationRepository } from "@/lib/customer-pic/conversation";
import type { OrderDisputeRepository } from "@/lib/order-disputes/repository";
import type { DeliveryRepositoryInterface } from "@/lib/delivery/repository";
import type { TodayDeliveryRepository } from "@/lib/daily-session/deliveries";
import type { TodayOrdersRepository } from "@/lib/daily-session/orders";
import type { ProblemReportRepository } from "./handlers/report-problem";
import type { CustomerDataGapRepository } from "@/lib/customers/data-completeness";
import {
  detectMenuTrigger,
  parseMenuCallbackData,
  parseNumberedChoice,
  type MenuAwaiting,
  type MenuConversationRepository,
} from "./conversation";
import { MAIN_MENU_ITEMS, buildMainMenuKeyboard, buildMainMenuText, resolveMenuAction } from "./menu";
import { buildOnDemandBrief } from "./handlers/morning-brief";
import { handleCloseDay, handleStartDay } from "./handlers/daily-session";
import {
  handleOrderLinkConfirm,
  handleOutcomeNotes,
  handlePicSelect,
  handleStoreSelect,
  startVisitFlow,
  type VisitHandlerDeps,
} from "./handlers/visit";
import {
  handleOrderIntakeSourceChoice,
  isPendingOrderIntakeText,
  startOrderIntakeFlow,
} from "./handlers/order-intake";
import { handleDeliverySelect, startDeliveryFlow, type DeliveryHandlerDeps } from "./handlers/delivery";
import { startAddStoreFlow } from "./handlers/add-store";
import { buildProgressMessage } from "./handlers/progress";
import { handleReportProblemNote, startReportProblemFlow } from "./handlers/report-problem";

export interface MenuRouterDeps {
  sender: TelegramSender;
  menuConversationRepository: MenuConversationRepository;
  dailySessionRepository: DailySessionRepository;
  salesKpiRepository: SalesKpiRepository;
  agendaRepository: AgendaRepository;
  customerPicRepository: CustomerPicRepository;
  storePicConversationRepository: StorePicConversationRepository;
  orderLookupRepository: Pick<OrderDisputeRepository, "findOrderByNumber">;
  todayDeliveryRepository: TodayDeliveryRepository;
  todayOrdersRepository: TodayOrdersRepository;
  deliveryRepository: Pick<DeliveryRepositoryInterface, "getDelivery" | "getConfirmedOrder" | "setConversationState">;
  problemReportRepository: ProblemReportRepository;
  /** PR data toko kredit di Morning Brief on-demand (/start) -- opsional, skip kalau tidak disediakan. */
  customerDataGapRepository?: CustomerDataGapRepository;
}

export interface MenuRouterContext {
  identity: ResolvedIdentity;
  chatId: number;
  tenantName: string;
  coverageAreas: string[];
  /** Business date Asia/Jakarta (businessDateJakarta()), disuplai caller. */
  businessDate: string;
}

export interface MenuUpdateInput {
  text: string | null;
  callbackData: string | null;
  callbackQueryId: string | null;
}

export interface MenuUpdateResult {
  handled: boolean;
  outcome: string;
}

const ACTIONS_NOT_YET_IMPLEMENTED = new Set<string>([]);

const VISIT_SUB_STATES: MenuAwaiting[] = [
  "visit_store_select",
  "visit_pic_select",
  "visit_outcome_notes",
  "visit_order_link_confirm",
];

function toVisitHandlerContext(ctx: MenuRouterContext): {
  companyId: string;
  actorId: string;
  salesmanId: string;
  businessDate: string;
} {
  return {
    companyId: ctx.identity.companyId,
    actorId: ctx.identity.userId,
    salesmanId: ctx.identity.userId,
    businessDate: ctx.businessDate,
  };
}

function toVisitHandlerDeps(deps: MenuRouterDeps): VisitHandlerDeps {
  return {
    agendaRepository: deps.agendaRepository,
    customerPicRepository: deps.customerPicRepository,
    salesKpiRepository: deps.salesKpiRepository,
    orderLookupRepository: deps.orderLookupRepository,
    dailySessionRepository: deps.dailySessionRepository,
  };
}

function toDeliveryHandlerContext(ctx: MenuRouterContext): {
  companyId: string;
  identityId: string;
  salesmanId: string;
} {
  return {
    companyId: ctx.identity.companyId,
    identityId: ctx.identity.identityId,
    salesmanId: ctx.identity.userId,
  };
}

function toDeliveryHandlerDeps(deps: MenuRouterDeps): DeliveryHandlerDeps {
  return {
    todayDeliveryRepository: deps.todayDeliveryRepository,
    deliveryRepository: deps.deliveryRepository,
  };
}

export async function handleMenuUpdate(
  input: MenuUpdateInput,
  ctx: MenuRouterContext,
  deps: MenuRouterDeps,
): Promise<MenuUpdateResult> {
  if (input.callbackQueryId) {
    await deps.sender.answerCallbackQuery(input.callbackQueryId);
  }

  const isMenuTrigger = input.text ? detectMenuTrigger(input.text) : false;
  if (isMenuTrigger) {
    await showMainMenu(ctx, deps);
    return { handled: true, outcome: "main_menu_shown" };
  }

  const callback = input.callbackData ? parseMenuCallbackData(input.callbackData) : null;
  const state = await deps.menuConversationRepository.getState(ctx.identity.identityId);

  if (state.awaiting === "main_menu") {
    const numberedChoice = input.text ? parseNumberedChoice(input.text, MAIN_MENU_ITEMS.length) : null;
    const action = resolveMenuAction({ numberedChoice, callbackAction: callback?.action ?? null });
    if (!action) {
      await deps.sender.sendMessage(
        ctx.chatId,
        "Pilihan tidak dikenali. Ketik /menu untuk melihat menu lagi.",
      );
      return { handled: true, outcome: "invalid_choice" };
    }
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, {
      awaiting: "none",
      draft: {},
    });
    return dispatchMenuAction(action, ctx, deps);
  }

  if (state.awaiting === "order_intake_awaiting_text" && input.text) {
    if (isPendingOrderIntakeText(state)) {
      // Route.ts seharusnya sudah mencegat kasus ini SEBELUM handleMenuUpdate
      // dipanggil (lihat loadMenuRouterContext/order-intake interception di
      // route.ts) -- kalau tetap sampai sini berarti ada race/state basi,
      // reset supaya salesman tidak terjebak menunggu.
      await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, {
        awaiting: "none",
        draft: {},
      });
      await deps.sender.sendMessage(ctx.chatId, "Sesi input order direset. Ketik /menu untuk memulai lagi.");
      return { handled: true, outcome: "order_intake_stale_state_reset" };
    }
    const step = handleOrderIntakeSourceChoice(input.text, state);
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "order_intake_source_selected" };
  }

  if (state.awaiting === "report_problem_note" && input.text) {
    const step = await handleReportProblemNote(
      input.text,
      { companyId: ctx.identity.companyId, identityId: ctx.identity.identityId, salesmanId: ctx.identity.userId },
      { problemReportRepository: deps.problemReportRepository },
    );
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "report_problem_step" };
  }

  if (state.awaiting === "delivery_select" && input.text) {
    const step = await handleDeliverySelect(input.text, state, toDeliveryHandlerContext(ctx), toDeliveryHandlerDeps(deps));
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "delivery_select_step" };
  }

  if (VISIT_SUB_STATES.includes(state.awaiting) && input.text) {
    const visitCtx = toVisitHandlerContext(ctx);
    const visitDeps = toVisitHandlerDeps(deps);
    const step =
      state.awaiting === "visit_store_select"
        ? await handleStoreSelect(input.text, state, visitCtx, visitDeps)
        : state.awaiting === "visit_pic_select"
          ? await handlePicSelect(input.text, state, visitCtx, visitDeps)
          : state.awaiting === "visit_outcome_notes"
            ? await handleOutcomeNotes(input.text, state, visitCtx, visitDeps)
            : await handleOrderLinkConfirm(input.text, state, visitCtx, visitDeps);

    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: `${state.awaiting}_step` };
  }

  if (state.awaiting !== "none") {
    // State sub-flow lain (mis. tambah toko/order/pengiriman) ditambahkan
    // phase berikutnya -- kalau tercapai di sini berarti state basi/tidak
    // dikenal, reset supaya salesman tidak terjebak.
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, {
      awaiting: "none",
      draft: {},
    });
    await deps.sender.sendMessage(ctx.chatId, "Sesi sebelumnya direset. Ketik /menu untuk memulai lagi.");
    return { handled: true, outcome: "stale_state_reset" };
  }

  if (callback) {
    return dispatchMenuAction(callback.action, ctx, deps);
  }

  return { handled: false, outcome: "not_menu_flow" };
}

async function showMainMenu(ctx: MenuRouterContext, deps: MenuRouterDeps): Promise<void> {
  const brief = await buildOnDemandBrief(
    {
      companyId: ctx.identity.companyId,
      actorId: ctx.identity.userId,
      salesmanId: ctx.identity.userId,
      salesmanFullName: ctx.identity.userFullName,
      coverageAreas: ctx.coverageAreas,
      tenantName: ctx.tenantName,
      businessDate: ctx.businessDate,
    },
    deps,
  );
  await deps.sender.sendMessage(ctx.chatId, brief);
  await deps.sender.sendMessageWithKeyboard(ctx.chatId, buildMainMenuText(), buildMainMenuKeyboard());
  await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, {
    awaiting: "main_menu",
    draft: {},
  });
}

async function dispatchMenuAction(
  action: string,
  ctx: MenuRouterContext,
  deps: MenuRouterDeps,
): Promise<MenuUpdateResult> {
  if (action === "start_day") {
    const message = await handleStartDay(
      {
        companyId: ctx.identity.companyId,
        actorId: ctx.identity.userId,
        salesmanId: ctx.identity.userId,
        businessDate: ctx.businessDate,
      },
      deps,
    );
    await deps.sender.sendMessage(ctx.chatId, message);
    return { handled: true, outcome: "start_day" };
  }

  if (action === "close_day") {
    const message = await handleCloseDay(
      {
        companyId: ctx.identity.companyId,
        actorId: ctx.identity.userId,
        salesmanId: ctx.identity.userId,
        businessDate: ctx.businessDate,
      },
      deps,
    );
    await deps.sender.sendMessage(ctx.chatId, message);
    return { handled: true, outcome: "close_day" };
  }

  if (action === "start_visit") {
    const step = await startVisitFlow(toVisitHandlerContext(ctx), toVisitHandlerDeps(deps));
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "start_visit" };
  }

  if (action === "order_intake") {
    const step = startOrderIntakeFlow();
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "order_intake_started" };
  }

  if (action === "agenda") {
    const stores = await deps.agendaRepository.listTodayStores(
      ctx.identity.companyId,
      ctx.identity.userId,
      ctx.businessDate,
    );
    const message =
      stores.length === 0
        ? "Tidak ada toko dalam cakupan Anda saat ini."
        : [
            `Agenda ${ctx.businessDate}:`,
            ...stores.map((s, i) => `${i + 1}. ${s.name}${s.visitedToday ? " (sudah dikunjungi)" : ""}`),
          ].join("\n");
    await deps.sender.sendMessage(ctx.chatId, message);
    return { handled: true, outcome: "agenda" };
  }

  if (action === "deliveries") {
    const step = await startDeliveryFlow(toDeliveryHandlerContext(ctx), toDeliveryHandlerDeps(deps));
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "deliveries" };
  }

  if (action === "add_store") {
    await startAddStoreFlow(ctx.chatId, ctx.identity, {
      repository: deps.customerPicRepository,
      conversationRepository: deps.storePicConversationRepository,
      sender: deps.sender,
    });
    return { handled: true, outcome: "add_store_started" };
  }

  if (action === "progress") {
    const message = await buildProgressMessage(
      { companyId: ctx.identity.companyId, actorId: ctx.identity.userId, salesmanId: ctx.identity.userId },
      { salesKpiRepository: deps.salesKpiRepository },
    );
    await deps.sender.sendMessage(ctx.chatId, message);
    return { handled: true, outcome: "progress" };
  }

  if (action === "report_problem") {
    const step = startReportProblemFlow();
    await deps.sender.sendMessage(ctx.chatId, step.message);
    await deps.menuConversationRepository.setState(ctx.identity.identityId, ctx.identity.companyId, step.nextState);
    return { handled: true, outcome: "report_problem_started" };
  }

  if (ACTIONS_NOT_YET_IMPLEMENTED.has(action)) {
    await deps.sender.sendMessage(ctx.chatId, "Fitur ini akan tersedia di update berikutnya.");
    return { handled: true, outcome: `${action}_not_implemented` };
  }

  await deps.sender.sendMessage(ctx.chatId, "Pilihan tidak dikenali. Ketik /menu untuk melihat menu lagi.");
  return { handled: true, outcome: "unknown_action" };
}
