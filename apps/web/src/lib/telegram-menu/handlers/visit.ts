// =============================================================================
// Mulai Kunjungan (Kunjungan Toko) -- state disimpan di
// telegram_menu_conversation_state (bukan tabel terpisah), mendelegasikan
// SEPENUHNYA ke record_sales_call/link_sales_order_call yang sudah ada
// (lib/sales-kpi). Tidak ada ledger paralel, tidak ada aturan Call/EC baru.
//
// PIC "tidak tersedia": repo TIDAK memiliki rule NEEDS_REVIEW eksplisit
// untuk kasus ini (diverifikasi -- record_sales_call tidak menerima
// parameter PIC sama sekali, validitas Call murni dari coverage/assignment).
// Karena itu kasus ini TIDAK menghasilkan status DB baru yang dikarang --
// hanya dicatat sebagai bagian outcome_notes ("[PIC tidak tersedia] ...")
// supaya tetap tertelusuri tanpa mengubah aturan valid Call yang sudah PASS.
// =============================================================================

import type { AgendaRepository } from "@/lib/daily-session/agenda";
import type { DailySessionRepository } from "@/lib/daily-session/repository";
import type { CustomerPicRepository } from "@/lib/customer-pic/repository";
import type { OrderDisputeRepository } from "@/lib/order-disputes/repository";
import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";
import { parseNumberedChoice, type MenuConversationState, type MenuDraft } from "../conversation";

export interface VisitHandlerDeps {
  agendaRepository: AgendaRepository;
  customerPicRepository: Pick<CustomerPicRepository, "listPicsForStore">;
  salesKpiRepository: SalesKpiRepository;
  orderLookupRepository: Pick<OrderDisputeRepository, "findOrderByNumber">;
  dailySessionRepository: Pick<DailySessionRepository, "findForBusinessDate">;
}

export interface VisitHandlerContext {
  companyId: string;
  actorId: string;
  salesmanId: string;
  businessDate: string;
}

export interface VisitStepResult {
  message: string;
  nextState: MenuConversationState;
}

const SKIP_WORDS = new Set(["tidak", "-", "skip", "no", "belum"]);

export async function startVisitFlow(
  ctx: VisitHandlerContext,
  deps: VisitHandlerDeps,
): Promise<VisitStepResult> {
  const session = await deps.dailySessionRepository.findForBusinessDate(
    ctx.companyId,
    ctx.salesmanId,
    ctx.businessDate,
  );
  if (session?.status === "CLOSED") {
    return {
      message: [
        "Hari ini sudah ditutup -- tidak bisa memulai kunjungan baru.",
        "Minta Owner/Manager membuka kembali (reopen) hari ini jika diperlukan.",
      ].join("\n"),
      nextState: { awaiting: "none", draft: {} },
    };
  }

  const stores = await deps.agendaRepository.listTodayStores(ctx.companyId, ctx.salesmanId, ctx.businessDate);
  if (stores.length === 0) {
    return {
      message: "Tidak ada toko dalam cakupan Anda saat ini. Hubungi admin jika ini tidak sesuai.",
      nextState: { awaiting: "none", draft: {} },
    };
  }

  const lines = ["Pilih toko untuk kunjungan:"];
  stores.forEach((store, i) => {
    lines.push(`${i + 1}. ${store.name}${store.visitedToday ? " (sudah dikunjungi hari ini)" : ""}`);
  });

  return {
    message: lines.join("\n"),
    nextState: {
      awaiting: "visit_store_select",
      draft: { storeOptions: stores.map((s) => ({ id: s.customerId, name: s.name })) },
    },
  };
}

export async function handleStoreSelect(
  text: string,
  state: MenuConversationState,
  ctx: VisitHandlerContext,
  deps: VisitHandlerDeps,
): Promise<VisitStepResult> {
  const options = (state.draft.storeOptions ?? []) as { id: string; name: string }[];
  const choice = parseNumberedChoice(text, options.length);
  if (!choice) {
    return { message: "Pilihan toko tidak valid. Balas dengan nomor toko.", nextState: state };
  }
  const selected = options[choice - 1]!;

  const pics = await deps.customerPicRepository.listPicsForStore(ctx.companyId, selected.id);
  const lines = [`Toko: ${selected.name}`, "Pilih PIC:"];
  pics.forEach((pic, i) => lines.push(`${i + 1}. ${pic.name}`));
  lines.push("0. PIC tidak tersedia");

  return {
    message: lines.join("\n"),
    nextState: {
      awaiting: "visit_pic_select",
      draft: {
        customerId: selected.id,
        customerName: selected.name,
        picOptions: pics.map((p) => ({ id: p.id, name: p.name })),
      },
    },
  };
}

export async function handlePicSelect(
  text: string,
  state: MenuConversationState,
  _ctx: VisitHandlerContext,
  _deps: VisitHandlerDeps,
): Promise<VisitStepResult> {
  const options = (state.draft.picOptions ?? []) as { id: string; name: string }[];
  const trimmed = text.trim();
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || String(n) !== trimmed || n < 0 || n > options.length) {
    return {
      message: "Pilihan PIC tidak valid. Balas dengan nomor PIC, atau 0 jika PIC tidak tersedia.",
      nextState: state,
    };
  }

  const draft: MenuDraft = { ...state.draft };
  if (n === 0) {
    draft.picId = null;
    draft.picName = null;
    draft.picUnavailable = true;
  } else {
    const selected = options[n - 1]!;
    draft.picId = selected.id;
    draft.picName = selected.name;
    draft.picUnavailable = false;
  }

  return {
    message: "Catat tujuan/hasil kunjungan (minimal 3 karakter):",
    nextState: { awaiting: "visit_outcome_notes", draft },
  };
}

const RECORD_CALL_MESSAGES: Record<string, string> = {
  duplicate_same_day: "Toko ini sudah dikunjungi hari ini.",
  out_of_coverage: "Toko ini di luar cakupan Anda.",
  customer_not_found: "Toko tidak ditemukan.",
  salesperson_not_eligible: "Akun Anda tidak terdaftar sebagai salesman aktif.",
  forbidden: "Anda tidak berwenang mencatat kunjungan ini.",
  outcome_required: "Catatan kunjungan tidak valid.",
  invalid_date: "Tanggal kunjungan tidak valid.",
  idempotency_key_required: "Terjadi kesalahan internal -- coba lagi.",
  invalid_input: "Input tidak valid.",
  invalid_authorization_task: "Otorisasi kunjungan tidak valid.",
  authorization_task_already_used: "Otorisasi kunjungan sudah dipakai.",
};

export async function handleOutcomeNotes(
  text: string,
  state: MenuConversationState,
  ctx: VisitHandlerContext,
  deps: VisitHandlerDeps,
): Promise<VisitStepResult> {
  const trimmed = text.trim();
  if (trimmed.length < 3) {
    return { message: "Catatan terlalu pendek (minimal 3 karakter). Coba lagi:", nextState: state };
  }

  const draft = state.draft;
  const customerId = draft.customerId as string;
  const customerName = (draft.customerName as string) ?? "";
  const picUnavailable = Boolean(draft.picUnavailable);
  const picName = draft.picName as string | null | undefined;
  const notePrefix = picUnavailable ? "[PIC tidak tersedia] " : picName ? `[PIC: ${picName}] ` : "";

  const result = await deps.salesKpiRepository.recordCall({
    companyId: ctx.companyId,
    actorId: ctx.actorId,
    salespersonId: ctx.salesmanId,
    customerId,
    callDate: ctx.businessDate,
    outcomeNotes: `${notePrefix}${trimmed}`,
    idempotencyKey: `visit:${ctx.salesmanId}:${customerId}:${ctx.businessDate}`,
  });

  if (result.outcome === "recorded" || result.outcome === "already_recorded") {
    return {
      message: [
        `Kunjungan tercatat. Toko: ${customerName}.`,
        'Jika kunjungan ini menghasilkan order, balas dengan NOMOR ORDER untuk dihubungkan. Jika belum, balas "tidak".',
      ].join("\n"),
      nextState: {
        awaiting: "visit_order_link_confirm",
        draft: { callId: result.callId, customerId, customerName },
      },
    };
  }

  if (result.outcome === "unexpected_error") {
    return {
      message: "Tidak dapat mencatat kunjungan saat ini. Coba lagi beberapa saat lagi.",
      nextState: { awaiting: "none", draft: {} },
    };
  }

  return {
    message: RECORD_CALL_MESSAGES[result.outcome] ?? "Tidak dapat mencatat kunjungan.",
    nextState: { awaiting: "none", draft: {} },
  };
}

const LINK_ORDER_MESSAGES: Record<string, string> = {
  already_linked: "Order ini sudah dihubungkan sebelumnya.",
  order_not_found: "Order tidak ditemukan.",
  call_not_found: "Kunjungan tidak ditemukan.",
  call_not_valid: "Kunjungan ini sudah tidak valid.",
  customer_mismatch: "Order ini bukan untuk toko yang sama.",
  salesperson_mismatch: "Order ini bukan milik Anda.",
  forbidden: "Anda tidak berwenang menghubungkan order ini.",
};

export async function handleOrderLinkConfirm(
  text: string,
  state: MenuConversationState,
  ctx: VisitHandlerContext,
  deps: VisitHandlerDeps,
): Promise<VisitStepResult> {
  const trimmed = text.trim();
  if (SKIP_WORDS.has(trimmed.toLowerCase())) {
    return { message: "Baik, kunjungan selesai tanpa order tertaut.", nextState: { awaiting: "none", draft: {} } };
  }

  const draft = state.draft;
  const callId = draft.callId as string;
  const customerId = draft.customerId as string;

  const order = await deps.orderLookupRepository.findOrderByNumber(ctx.companyId, trimmed.toUpperCase());
  if (!order) {
    return {
      message: `Order "${trimmed}" tidak ditemukan. Coba lagi, atau balas "tidak" untuk melewati.`,
      nextState: state,
    };
  }
  if (order.customerId !== customerId) {
    return {
      message: 'Order ini bukan untuk toko yang sama dengan kunjungan ini. Coba lagi, atau balas "tidak" untuk melewati.',
      nextState: state,
    };
  }

  const linkResult = await deps.salesKpiRepository.linkOrderCall({
    companyId: ctx.companyId,
    actorId: ctx.actorId,
    orderId: order.id,
    callId,
  });

  const message =
    linkResult.outcome === "linked"
      ? `Order ${order.orderNumber} berhasil dihubungkan ke kunjungan ini.`
      : (LINK_ORDER_MESSAGES[linkResult.outcome] ?? "Tidak dapat menghubungkan order.");

  return { message, nextState: { awaiting: "none", draft: {} } };
}
