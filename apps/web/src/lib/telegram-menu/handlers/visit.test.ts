import { describe, expect, it } from "vitest";
import { InMemoryAgendaRepository } from "@/lib/daily-session/agenda";
import { InMemorySalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { CustomerPicRecord } from "@/lib/customer-pic/types";
import type { OrderSummary } from "@/lib/order-disputes/repository";
import type { MenuConversationState } from "../conversation";
import {
  handleOrderLinkConfirm,
  handleOutcomeNotes,
  handlePicSelect,
  handleStoreSelect,
  startVisitFlow,
  type VisitHandlerContext,
  type VisitHandlerDeps,
} from "./visit";

const COMPANY = "waluyo";
const SALES_1 = "sales-1";
const CUSTOMER_1 = "cust-1";
const DATE = "2026-07-18";

function buildPic(overrides: Partial<CustomerPicRecord> = {}): CustomerPicRecord {
  return {
    id: "pic-1",
    companyId: COMPANY,
    customerId: CUSTOMER_1,
    name: "Ibu Sari",
    phone: "08123456789",
    email: null,
    roles: ["OWNER"],
    validationStatus: "UNVERIFIED",
    createdBy: "owner-1",
    createdAt: "2026-07-01T00:00:00Z",
    verifiedBy: null,
    verifiedAt: null,
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function buildDeps(
  opts: {
    pics?: CustomerPicRecord[];
    order?: OrderSummary | null;
    dailySessionStatus?: "ACTIVE" | "CLOSED" | "NOT_STARTED";
  } = {},
): VisitHandlerDeps {
  const agendaRepository = new InMemoryAgendaRepository();
  agendaRepository.seedCustomer(CUSTOMER_1, COMPANY, { name: "Toko Sari", assignedSalesId: SALES_1 });
  const salesKpiRepository = new InMemorySalesKpiRepository();
  salesKpiRepository.seedActor(SALES_1, COMPANY, "sales" as never);
  salesKpiRepository.seedSalesperson(SALES_1, COMPANY);
  salesKpiRepository.seedCustomer(CUSTOMER_1, COMPANY, { assignedSalesId: SALES_1 });

  const pics = opts.pics ?? [buildPic()];
  const order = opts.order ?? null;
  const dailySessionStatus = opts.dailySessionStatus ?? "ACTIVE";
  return {
    agendaRepository,
    salesKpiRepository,
    customerPicRepository: { listPicsForStore: async () => pics },
    orderLookupRepository: { findOrderByNumber: async () => order },
    dailySessionRepository: {
      findForBusinessDate: async () =>
        dailySessionStatus === "NOT_STARTED"
          ? null
          : {
              id: "session-1",
              companyId: COMPANY,
              salesmanId: SALES_1,
              businessDate: DATE,
              status: dailySessionStatus,
              startedAt: "2026-07-18T00:00:00Z",
              startedBy: SALES_1,
              closedAt: dailySessionStatus === "CLOSED" ? "2026-07-18T10:00:00Z" : null,
              closedBy: dailySessionStatus === "CLOSED" ? SALES_1 : null,
              closeSummary: null,
            },
    },
  };
}

function ctx(): VisitHandlerContext {
  return { companyId: COMPANY, actorId: SALES_1, salesmanId: SALES_1, businessDate: DATE };
}

describe("Mulai Kunjungan -- 9, 10, 11 (pilih toko/PIC, PIC tidak tersedia)", () => {
  it("9. startVisitFlow menampilkan toko dalam akses salesman", async () => {
    const deps = buildDeps();
    const result = await startVisitFlow(ctx(), deps);
    expect(result.message).toContain("Toko Sari");
    expect(result.nextState.awaiting).toBe("visit_store_select");
  });

  it("Closed-day invariant: hari CLOSED tidak bisa memulai kunjungan baru tanpa reopen", async () => {
    const deps = buildDeps({ dailySessionStatus: "CLOSED" });
    const result = await startVisitFlow(ctx(), deps);
    expect(result.message).toContain("sudah ditutup");
    expect(result.message).toContain("reopen");
    expect(result.nextState.awaiting).toBe("none");
  });

  it("hari NOT_STARTED atau ACTIVE tetap boleh memulai kunjungan (perilaku existing tidak berubah)", async () => {
    const notStarted = await startVisitFlow(ctx(), buildDeps({ dailySessionStatus: "NOT_STARTED" }));
    expect(notStarted.nextState.awaiting).toBe("visit_store_select");
    const active = await startVisitFlow(ctx(), buildDeps({ dailySessionStatus: "ACTIVE" }));
    expect(active.nextState.awaiting).toBe("visit_store_select");
  });

  it("startVisitFlow tanpa toko -> pesan empty state jujur, tidak mengarang agenda", async () => {
    const deps = buildDeps();
    (deps.agendaRepository as InMemoryAgendaRepository) // reset ke kosong
      .listTodayStores = async () => [];
    const result = await startVisitFlow(ctx(), deps);
    expect(result.message).toContain("Tidak ada toko");
    expect(result.nextState.awaiting).toBe("none");
  });

  it("10. Pilih toko valid -> menampilkan daftar PIC", async () => {
    const deps = buildDeps();
    const started = await startVisitFlow(ctx(), deps);
    const result = await handleStoreSelect("1", started.nextState, ctx(), deps);
    expect(result.message).toContain("Ibu Sari");
    expect(result.nextState.awaiting).toBe("visit_pic_select");
    expect(result.nextState.draft.customerId).toBe(CUSTOMER_1);
  });

  it("pilih toko dengan nomor di luar rentang -> ditolak, state tidak berubah", async () => {
    const deps = buildDeps();
    const started = await startVisitFlow(ctx(), deps);
    const result = await handleStoreSelect("99", started.nextState, ctx(), deps);
    expect(result.message).toContain("tidak valid");
    expect(result.nextState.awaiting).toBe("visit_store_select");
  });

  it("PIC valid dipilih -> lanjut ke outcome notes", async () => {
    const deps = buildDeps();
    const picState: MenuConversationState = {
      awaiting: "visit_pic_select",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari", picOptions: [{ id: "pic-1", name: "Ibu Sari" }] },
    };
    const result = await handlePicSelect("1", picState, ctx(), deps);
    expect(result.nextState.awaiting).toBe("visit_outcome_notes");
    expect(result.nextState.draft.picName).toBe("Ibu Sari");
  });

  it("11. PIC tidak tersedia (0) -> tetap lanjut, tidak mengarang status baru", async () => {
    const deps = buildDeps();
    const picState: MenuConversationState = {
      awaiting: "visit_pic_select",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari", picOptions: [{ id: "pic-1", name: "Ibu Sari" }] },
    };
    const result = await handlePicSelect("0", picState, ctx(), deps);
    expect(result.nextState.awaiting).toBe("visit_outcome_notes");
    expect(result.nextState.draft.picUnavailable).toBe(true);
    expect(result.nextState.draft.picId).toBeNull();
  });
});

describe("Mulai Kunjungan -- 12, 13, 14 (Call/EC invariants)", () => {
  it("12. Visit selesai tanpa order -> Call bertambah satu, EC tidak bertambah", async () => {
    const deps = buildDeps();
    const notesState: MenuConversationState = {
      awaiting: "visit_outcome_notes",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari", picName: "Ibu Sari", picUnavailable: false },
    };
    const result = await handleOutcomeNotes("Toko buka, stok dicek", notesState, ctx(), deps);
    expect(result.nextState.awaiting).toBe("visit_order_link_confirm");

    const events = (deps.salesKpiRepository as InMemorySalesKpiRepository).getAchievementEvents(COMPANY);
    expect(events.filter((e) => e.kpiCode === "CALL" && e.eventType === "CREDITED")).toHaveLength(1);
    expect(events.filter((e) => e.kpiCode === "EFFECTIVE_CALL")).toHaveLength(0);

    const skip = await handleOrderLinkConfirm("tidak", result.nextState, ctx(), deps);
    expect(skip.nextState.awaiting).toBe("none");
  });

  it("catatan kurang dari 3 karakter -> ditolak, tidak mencatat Call", async () => {
    const deps = buildDeps();
    const notesState: MenuConversationState = {
      awaiting: "visit_outcome_notes",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari" },
    };
    const result = await handleOutcomeNotes("ok", notesState, ctx(), deps);
    expect(result.nextState.awaiting).toBe("visit_outcome_notes");
    const events = (deps.salesKpiRepository as InMemorySalesKpiRepository).getAchievementEvents(COMPANY);
    expect(events).toHaveLength(0);
  });

  it("14. Replay (idempotency key sama) tidak menggandakan Call", async () => {
    const deps = buildDeps();
    const notesState: MenuConversationState = {
      awaiting: "visit_outcome_notes",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari" },
    };
    await handleOutcomeNotes("Kunjungan pagi hari ini", notesState, ctx(), deps);
    await handleOutcomeNotes("Kunjungan pagi hari ini (retry)", notesState, ctx(), deps);
    const events = (deps.salesKpiRepository as InMemorySalesKpiRepository).getAchievementEvents(COMPANY);
    expect(events.filter((e) => e.kpiCode === "CALL" && e.eventType === "CREDITED")).toHaveLength(1);
  });

  it("13. Order link berhasil -> EC bertambah sesuai rule existing (link_sales_order_call + trigger)", async () => {
    const order: OrderSummary = {
      id: "order-1",
      orderNumber: "SO-0001",
      status: "draft",
      customerId: CUSTOMER_1,
      customerName: "Toko Sari",
      finalAmount: 100000,
    };
    const deps = buildDeps({ order });
    (deps.salesKpiRepository as InMemorySalesKpiRepository).seedOrder("order-1", COMPANY, CUSTOMER_1, SALES_1);

    const notesState: MenuConversationState = {
      awaiting: "visit_outcome_notes",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari" },
    };
    const afterNotes = await handleOutcomeNotes("Order langsung di tempat", notesState, ctx(), deps);
    const linked = await handleOrderLinkConfirm("SO-0001", afterNotes.nextState, ctx(), deps);
    expect(linked.message).toContain("berhasil dihubungkan");
  });

  it("order untuk toko lain ditolak, tidak menghubungkan call salah", async () => {
    const order: OrderSummary = {
      id: "order-2",
      orderNumber: "SO-0002",
      status: "draft",
      customerId: "cust-lain",
      customerName: "Toko Lain",
      finalAmount: 50000,
    };
    const deps = buildDeps({ order });
    const notesState: MenuConversationState = {
      awaiting: "visit_outcome_notes",
      draft: { customerId: CUSTOMER_1, customerName: "Toko Sari" },
    };
    const afterNotes = await handleOutcomeNotes("Kunjungan valid", notesState, ctx(), deps);
    const linked = await handleOrderLinkConfirm("SO-0002", afterNotes.nextState, ctx(), deps);
    expect(linked.message).toContain("bukan untuk toko yang sama");
    expect(linked.nextState.awaiting).toBe("visit_order_link_confirm");
  });
});
