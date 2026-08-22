// =============================================================================
// Target & Pencapaian -- presenter tipis, SAMA persis pola dengan
// buildMorningBrief (formatLine diimpor, bukan diduplikasi). Tidak pernah
// menghitung Call/EC/EC Rate sendiri -- murni membaca
// getAchievementProjection yang sudah ada (lib/sales-kpi).
// =============================================================================

import { formatLine } from "@/lib/n8n-automation/morning-brief";
import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";

export interface ProgressHandlerContext {
  companyId: string;
  actorId: string;
  salesmanId: string;
}

export async function buildProgressMessage(
  ctx: ProgressHandlerContext,
  deps: { salesKpiRepository: SalesKpiRepository },
): Promise<string> {
  const activePeriod = await deps.salesKpiRepository.findActivePeriod(ctx.companyId);
  if (!activePeriod) {
    return [
      "Periode KPI belum diaktifkan Owner.",
      "Target belum tersedia -- bukan berarti target 0.",
    ].join("\n");
  }

  const result = await deps.salesKpiRepository.getAchievementProjection({
    companyId: ctx.companyId,
    actorId: ctx.actorId,
    periodId: activePeriod.id,
    salespersonId: ctx.salesmanId,
  });
  if (result.outcome !== "ok") {
    return "Tidak dapat mengambil data pencapaian saat ini. Coba lagi beberapa saat lagi.";
  }

  const { call, effectiveCall } = result.projection;
  const ecRate = call.actual > 0 ? Math.round((effectiveCall.actual / call.actual) * 100) : null;

  return [
    `Periode: ${activePeriod.name}`,
    `Call: ${formatLine(call.target, call.actual, call.achievementPercentage)}`,
    `Effective Call: ${formatLine(effectiveCall.target, effectiveCall.actual, effectiveCall.achievementPercentage)}`,
    `EC Rate: ${ecRate !== null ? `${ecRate}% dari ${effectiveCall.actual}/${call.actual} call (insight, bukan KPI)` : "Data belum cukup"}`,
  ].join("\n");
}
