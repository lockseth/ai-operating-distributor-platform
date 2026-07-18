import { describe, expect, it } from "vitest";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import { InMemoryDailySessionRepository } from "@/lib/daily-session/repository";
import { InMemoryAgendaRepository } from "@/lib/daily-session/agenda";
import { InMemorySalesKpiRepository } from "@/lib/sales-kpi/repository";
import { InMemoryCustomerPicRepository } from "@/lib/customer-pic/repository";
import { InMemoryOrderDisputeRepository } from "@/lib/order-disputes/repository";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";
import { InMemoryTodayDeliveryRepository } from "@/lib/daily-session/deliveries";
import { InMemoryTodayOrdersRepository } from "@/lib/daily-session/orders";
import { InMemoryStorePicConversationRepository } from "@/lib/customer-pic/conversation";
import { InMemoryProblemReportRepository } from "./handlers/report-problem";
import { dailySessionIdempotencyKey } from "@/lib/daily-session/service";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";
import { InMemoryMenuConversationRepository } from "./conversation";
import { handleMenuUpdate, type MenuRouterContext, type MenuRouterDeps } from "./router";

const IDENTITY: ResolvedIdentity = {
  identityId: "identity-1",
  companyId: "waluyo",
  userId: "sales-1",
  userFullName: "Budi",
};

function buildDeps(): MenuRouterDeps & {
  sender: RecordingTelegramSender;
  dailySessionRepository: InMemoryDailySessionRepository;
  salesKpiRepository: InMemorySalesKpiRepository;
  menuConversationRepository: InMemoryMenuConversationRepository;
  agendaRepository: InMemoryAgendaRepository;
  customerPicRepository: InMemoryCustomerPicRepository;
  problemReportRepository: InMemoryProblemReportRepository;
} {
  const dailySessionRepository = new InMemoryDailySessionRepository();
  dailySessionRepository.seedActor("sales-1", "waluyo", "sales");
  dailySessionRepository.seedSalesman("sales-1", "waluyo");
  const salesKpiRepository = new InMemorySalesKpiRepository();
  const sender = new RecordingTelegramSender();
  const menuConversationRepository = new InMemoryMenuConversationRepository();
  const agendaRepository = new InMemoryAgendaRepository();
  const customerPicRepository = new InMemoryCustomerPicRepository();
  const orderLookupRepository = new InMemoryOrderDisputeRepository();
  const todayDeliveryRepository = new InMemoryTodayDeliveryRepository();
  const todayOrdersRepository = new InMemoryTodayOrdersRepository();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const storePicConversationRepository = new InMemoryStorePicConversationRepository();
  const problemReportRepository = new InMemoryProblemReportRepository();
  return {
    sender,
    menuConversationRepository,
    dailySessionRepository,
    salesKpiRepository,
    agendaRepository,
    customerPicRepository,
    storePicConversationRepository,
    orderLookupRepository,
    todayDeliveryRepository,
    todayOrdersRepository,
    deliveryRepository,
    problemReportRepository,
  };
}

function buildCtx(overrides: Partial<MenuRouterContext> = {}): MenuRouterContext {
  return {
    identity: IDENTITY,
    chatId: 12345,
    tenantName: "Waluyo Distributor",
    coverageAreas: ["Utara"],
    businessDate: "2026-07-18",
    ...overrides,
  };
}

describe("handleMenuUpdate -- /start menampilkan Morning Brief + Menu Utama", () => {
  it("/start mengirim brief lalu menu dengan keyboard, set awaiting=main_menu", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    const result = await handleMenuUpdate(
      { text: "/start", callbackData: null, callbackQueryId: null },
      ctx,
      deps,
    );
    expect(result.outcome).toBe("main_menu_shown");
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0]!.text).toContain("Budi");
    expect(deps.sender.sent[0]!.text).toContain("BELUM dimulai");
    expect(deps.sender.sentWithKeyboard).toHaveLength(1);
    expect(deps.sender.sentWithKeyboard[0]!.text).toContain("Mulai Hari");
    const state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("main_menu");
  });

  it("/menu sama seperti /start (trigger case-insensitive)", async () => {
    const deps = buildDeps();
    const result = await handleMenuUpdate(
      { text: "/MENU", callbackData: null, callbackQueryId: null },
      buildCtx(),
      deps,
    );
    expect(result.outcome).toBe("main_menu_shown");
  });
});

describe("handleMenuUpdate -- pilihan Menu Utama (nomor & callback)", () => {
  it("3. Mulai Hari via nomor '1' saat awaiting=main_menu -> start_day, awaiting direset", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "1", callbackData: null, callbackQueryId: null }, ctx, deps);
    expect(result.outcome).toBe("start_day");
    expect(deps.sender.sent.at(-1)!.text).toContain("dimulai");
    const session = await deps.dailySessionRepository.findForBusinessDate("waluyo", "sales-1", "2026-07-18");
    expect(session?.status).toBe("ACTIVE");
    const state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("none");
  });

  it("Tutup Hari via callback menu:close_day -> mengirim jawab callback + close_day", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    await deps.dailySessionRepository.start({
      companyId: "waluyo",
      actorId: "sales-1",
      salesmanId: "sales-1",
      businessDate: "2026-07-18",
      idempotencyKey: dailySessionIdempotencyKey("sales-1", "2026-07-18"),
    });
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate(
      { text: null, callbackData: "menu:close_day", callbackQueryId: "cbq-1" },
      ctx,
      deps,
    );
    expect(result.outcome).toBe("close_day");
    expect(deps.sender.answeredCallbackQueries).toContain("cbq-1");
    const session = await deps.dailySessionRepository.findForBusinessDate("waluyo", "sales-1", "2026-07-18");
    expect(session?.status).toBe("CLOSED");
  });

  it("pilihan tidak dikenali -> pesan error, awaiting tetap main_menu", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "99", callbackData: null, callbackQueryId: null }, ctx, deps);
    expect(result.outcome).toBe("invalid_choice");
    const state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("main_menu");
  });

  it("Tambah Toko (nomor '6') memicu processAddStoreMessage yang sudah ada (bukan logic baru)", async () => {
    const deps = buildDeps();
    deps.customerPicRepository.seedSalesmanCoverage("waluyo", "sales-1", ["Utara"]);
    const ctx = buildCtx();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "6", callbackData: null, callbackQueryId: null }, ctx, deps);
    expect(result.outcome).toBe("add_store_started");
    const state = await deps.storePicConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("store_name");
  });

  it("Target & Pencapaian (nomor '7') tanpa periode ACTIVE -> pesan jujur, bukan angka 0", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "7", callbackData: null, callbackQueryId: null }, ctx, deps);
    expect(result.outcome).toBe("progress");
    expect(deps.sender.sent.at(-1)!.text).toContain("belum diaktifkan");
  });

  it("Laporkan Masalah (nomor '9') mencatat satu baris audit, tanpa tabel baru", async () => {
    const deps = buildDeps();
    const ctx = buildCtx();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const started = await handleMenuUpdate({ text: "9", callbackData: null, callbackQueryId: null }, ctx, deps);
    expect(started.outcome).toBe("report_problem_started");

    const noted = await handleMenuUpdate(
      { text: "Aplikasi lambat saat kirim foto bukti", callbackData: null, callbackQueryId: null },
      ctx,
      deps,
    );
    expect(noted.outcome).toBe("report_problem_step");
    expect(deps.problemReportRepository.reports).toHaveLength(1);
    expect(deps.problemReportRepository.reports[0]!.note).toContain("lambat");
  });

  it("Input Order WA/Telepon (nomor '4') menanyakan sumber lalu menandai pending text", async () => {
    const deps = buildDeps();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const started = await handleMenuUpdate({ text: "4", callbackData: null, callbackQueryId: null }, buildCtx(), deps);
    expect(started.outcome).toBe("order_intake_started");
    let state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("order_intake_awaiting_text");
    expect(state.draft.orderSource).toBeUndefined();

    const chose = await handleMenuUpdate({ text: "1", callbackData: null, callbackQueryId: null }, buildCtx(), deps);
    expect(chose.outcome).toBe("order_intake_source_selected");
    state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.draft.orderSource).toBe("CUSTOMER_WHATSAPP");
    expect(deps.sender.sent.at(-1)!.text).toContain("ketik pesanan");
  });

  it("Pengiriman Hari Ini (nomor '5') tanpa delivery -> empty state jujur", async () => {
    const deps = buildDeps();
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "5", callbackData: null, callbackQueryId: null }, buildCtx(), deps);
    expect(result.outcome).toBe("deliveries");
    expect(deps.sender.sent.at(-1)!.text).toContain("Tidak ada pengiriman");
  });

  it("Agenda Hari Ini (nomor '2') menampilkan toko dalam cakupan salesman", async () => {
    const deps = buildDeps();
    deps.agendaRepository.seedCustomer("cust-1", "waluyo", { name: "Toko Sari", assignedSalesId: "sales-1" });
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "2", callbackData: null, callbackQueryId: null }, buildCtx(), deps);
    expect(result.outcome).toBe("agenda");
    expect(deps.sender.sent.at(-1)!.text).toContain("Toko Sari");
  });

  it("Mulai Kunjungan (nomor '3') memulai sub-flow visit_store_select", async () => {
    const deps = buildDeps();
    deps.agendaRepository.seedCustomer("cust-1", "waluyo", { name: "Toko Sari", assignedSalesId: "sales-1" });
    await deps.menuConversationRepository.setState(IDENTITY.identityId, IDENTITY.companyId, {
      awaiting: "main_menu",
      draft: {},
    });
    const result = await handleMenuUpdate({ text: "3", callbackData: null, callbackQueryId: null }, buildCtx(), deps);
    expect(result.outcome).toBe("start_visit");
    const state = await deps.menuConversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("visit_store_select");
  });
});

describe("handleMenuUpdate -- bukan bagian alur menu", () => {
  it("teks biasa tanpa awaiting main_menu dan tanpa trigger -> handled=false (caller lanjut cascade lain)", async () => {
    const deps = buildDeps();
    const result = await handleMenuUpdate(
      { text: "halo, ini pesan order biasa", callbackData: null, callbackQueryId: null },
      buildCtx(),
      deps,
    );
    expect(result.handled).toBe(false);
    expect(result.outcome).toBe("not_menu_flow");
    expect(deps.sender.sent).toHaveLength(0);
  });
});
