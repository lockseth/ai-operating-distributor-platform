// =============================================================================
// End-of-Day Summary -- dikomposisi saat Tutup Hari (I. END-OF-DAY SUMMARY).
// Presenter murni: SETIAP angka datang dari service yang SUDAH ADA
// (sales-kpi projection, agenda, delivery, order) -- file ini tidak pernah
// menghitung Call/EC/EC Rate sendiri (pola sama dengan morning-brief.ts).
// Collection/AR SELALU placeholder jujur -- tidak pernah angka dikarang
// (H. COLLECTION PLACEHOLDER).
// =============================================================================

import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { AgendaRepository } from "./agenda";
import type { TodayDeliveryRepository } from "./deliveries";
import type { TodayOrdersRepository } from "./orders";
import { isTerminalStatus } from "@/lib/delivery/types";
import { formatLine } from "@/lib/n8n-automation/morning-brief";

export interface EndOfDaySummaryContext {
  companyId: string;
  actorId: string;
  salesmanId: string;
  businessDate: string;
}

export interface EndOfDaySummaryDeps {
  salesKpiRepository: SalesKpiRepository;
  agendaRepository: AgendaRepository;
  todayDeliveryRepository: TodayDeliveryRepository;
  todayOrdersRepository: TodayOrdersRepository;
}

export interface EndOfDaySummary {
  businessDate: string;
  callActual: number;
  callTarget: number | null;
  effectiveCallActual: number;
  effectiveCallTarget: number | null;
  ecRate: number | null;
  ordersConfirmedToday: number;
  deliveriesCompleted: number;
  deliveriesPending: number;
  unfinishedStores: string[];
  arNote: string;
}

const AR_NOT_AVAILABLE_NOTE = "Data AR/tagihan belum tersedia.";

export async function composeEndOfDaySummary(
  ctx: EndOfDaySummaryContext,
  deps: EndOfDaySummaryDeps,
): Promise<{ summary: EndOfDaySummary; text: string }> {
  const activePeriod = await deps.salesKpiRepository.findActivePeriod(ctx.companyId);

  let callActual = 0;
  let callTarget: number | null = null;
  let effectiveCallActual = 0;
  let effectiveCallTarget: number | null = null;
  let callPacingNote = "";

  if (activePeriod) {
    const projectionResult = await deps.salesKpiRepository.getAchievementProjection({
      companyId: ctx.companyId,
      actorId: ctx.actorId,
      periodId: activePeriod.id,
      salespersonId: ctx.salesmanId,
    });
    if (projectionResult.outcome === "ok") {
      const { call, effectiveCall } = projectionResult.projection;
      callActual = call.actual;
      callTarget = call.target;
      effectiveCallActual = effectiveCall.actual;
      effectiveCallTarget = effectiveCall.target;
      callPacingNote = ` (${call.pacingStatus})`;
    }
  }

  const ecRate = callActual > 0 ? Math.round((effectiveCallActual / callActual) * 100) : null;

  const stores = await deps.agendaRepository.listTodayStores(ctx.companyId, ctx.salesmanId, ctx.businessDate);
  const unfinishedStores = stores.filter((s) => !s.visitedToday).map((s) => s.name);

  const allDeliveries = await deps.todayDeliveryRepository.listAllAssignedDeliveries(ctx.companyId, ctx.salesmanId);
  const deliveriesCompleted = allDeliveries.filter((d) => isTerminalStatus(d.status)).length;
  const deliveriesPending = allDeliveries.length - deliveriesCompleted;

  const ordersConfirmedToday = await deps.todayOrdersRepository.countConfirmedToday(
    ctx.companyId,
    ctx.salesmanId,
    ctx.businessDate,
  );

  const summary: EndOfDaySummary = {
    businessDate: ctx.businessDate,
    callActual,
    callTarget,
    effectiveCallActual,
    effectiveCallTarget,
    ecRate,
    ordersConfirmedToday,
    deliveriesCompleted,
    deliveriesPending,
    unfinishedStores,
    arNote: AR_NOT_AVAILABLE_NOTE,
  };

  const lines = [
    `Ringkasan Tutup Hari -- ${ctx.businessDate}`,
    "",
    `Call: ${formatLine(callTarget, callActual, callTarget !== null ? Math.round((callActual / callTarget) * 100) : null)}${callPacingNote}`,
    `Effective Call: ${formatLine(effectiveCallTarget, effectiveCallActual, effectiveCallTarget !== null ? Math.round((effectiveCallActual / effectiveCallTarget) * 100) : null)}`,
    `EC Rate: ${ecRate !== null ? `${ecRate}% (insight, bukan KPI)` : "Data belum cukup"}`,
    `Order confirmed: ${ordersConfirmedToday}`,
    `Pengiriman selesai: ${deliveriesCompleted} | belum selesai: ${deliveriesPending}`,
    `Kunjungan belum selesai: ${unfinishedStores.length === 0 ? "tidak ada" : unfinishedStores.join(", ")}`,
    `Collection: ${AR_NOT_AVAILABLE_NOTE}`,
  ];

  return { summary, text: lines.join("\n") };
}
