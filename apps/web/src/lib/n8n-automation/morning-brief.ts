// =============================================================================
// Morning Brief -- presenter. Konten SELALU dari data yang sudah dihitung
// lib/sales-kpi/* (computeAchievementLine, getAchievementProjection,
// getCalibrationBaseline) -- file ini HANYA merangkai teks, tidak pernah
// menghitung Call/EC/achievement/EC Rate sendiri.
// =============================================================================

import type {
  ActiveSalesKpiPeriod,
  SalesKpiAchievementProjection,
  SalesKpiCalibrationBaseline,
} from "@/lib/sales-kpi/types";
import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { CustomerDataGapCounts, CustomerDataGapRepository } from "@/lib/customers/data-completeness";
import { formatRupiah } from "@/lib/document-engine/monetary";

export interface MorningBriefContext {
  tenantName: string;
  salesmanFullName: string;
  coverageAreas: string[];
  businessDate: string;
  activePeriod: ActiveSalesKpiPeriod | null;
  /** null jika activePeriod null (tidak ada projection untuk periode yang tidak ada). */
  projection: SalesKpiAchievementProjection | null;
  /** null jika tidak relevan ditampilkan (mis. sudah SUFFICIENT). */
  baseline: SalesKpiCalibrationBaseline | null;
  /**
   * PR data toko kredit (foto depan toko/GPS kosong) -- opsional/null kalau
   * dependency tidak disediakan pemanggil (skip bagian ini, bukan error).
   * Toko CASH TIDAK PERNAH masuk hitungan ini (lihat
   * lib/customers/data-completeness.ts).
   */
  dataGaps?: CustomerDataGapCounts | null;
  /** Link ke daftar toko kredit yang bisa dilengkapi -- hanya dipakai kalau dataGaps ada gap. */
  customersUrl?: string | null;
}

export interface MorningBriefContent {
  text: string;
  structured: Record<string, unknown>;
}

export function formatLine(target: number | null, actual: number, percentage: number | null): string {
  if (target === null) return `${actual} (Data belum cukup -- target belum ditetapkan)`;
  return `${actual}/${target} (${percentage ?? 0}%)`;
}

/** Sama seperti formatLine, tapi untuk metrik uang -- actual/target ditampilkan format Rupiah (mis. "Rp21.496.260/Rp100.000.000"), bukan angka mentah. */
export function formatCurrencyLine(target: number | null, actual: number, percentage: number | null): string {
  if (target === null) return `${formatRupiah(actual)} (Data belum cukup -- target belum ditetapkan)`;
  return `${formatRupiah(actual)}/${formatRupiah(target)} (${percentage ?? 0}%)`;
}

/** PR data toko kredit -- ditambahkan di akhir brief, terlepas dari status periode KPI. */
function appendDataGapLines(lines: string[], ctx: MorningBriefContext): void {
  if (!ctx.dataGaps) return;
  const { missingPhoto, missingGps } = ctx.dataGaps;
  if (missingPhoto === 0 && missingGps === 0) return;

  lines.push("");
  lines.push("PR Data Toko Kredit:");
  if (missingPhoto > 0) lines.push(`${missingPhoto} toko belum ada foto depan toko`);
  if (missingGps > 0) lines.push(`${missingGps} toko belum ada titik GPS`);
  if (ctx.customersUrl) lines.push(`Lengkapi: ${ctx.customersUrl}`);
}

export function buildMorningBrief(ctx: MorningBriefContext): MorningBriefContent {
  const lines: string[] = [];
  lines.push(`Selamat pagi, ${ctx.salesmanFullName}`);
  lines.push(`${ctx.tenantName} -- Ringkasan KPI ${ctx.businessDate}`);
  lines.push("");
  lines.push(`Wilayah: ${ctx.coverageAreas.length > 0 ? ctx.coverageAreas.join(", ") : "-"}`);
  lines.push("");

  if (!ctx.activePeriod || !ctx.projection) {
    lines.push("Periode KPI belum diaktifkan Owner.");
    lines.push("Target belum tersedia -- bukan berarti target 0.");
    appendDataGapLines(lines, ctx);
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        salesmanFullName: ctx.salesmanFullName,
        coverageAreas: ctx.coverageAreas,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
        dataGaps: ctx.dataGaps,
      },
    };
  }

  lines.push(`Periode: ${ctx.activePeriod.name}`);
  lines.push(
    `Call: ${formatLine(ctx.projection.call.target, ctx.projection.call.actual, ctx.projection.call.achievementPercentage)}`,
  );
  lines.push(
    `Effective Call: ${formatLine(ctx.projection.effectiveCall.target, ctx.projection.effectiveCall.actual, ctx.projection.effectiveCall.achievementPercentage)}`,
  );
  lines.push(
    `Order: ${formatLine(ctx.projection.orderCount.target, ctx.projection.orderCount.actual, ctx.projection.orderCount.achievementPercentage)}`,
  );
  lines.push(
    `Revenue: ${formatCurrencyLine(ctx.projection.revenue.target, Math.round(ctx.projection.revenue.actual), ctx.projection.revenue.achievementPercentage)}`,
  );

  const ecRate =
    ctx.projection.call.actual > 0
      ? Math.round((ctx.projection.effectiveCall.actual / ctx.projection.call.actual) * 100)
      : null;
  lines.push(
    `EC Rate: ${ecRate !== null ? `${ecRate}% dari ${ctx.projection.effectiveCall.actual}/${ctx.projection.call.actual} call (insight, bukan KPI)` : "Data belum cukup"}`,
  );

  if (ctx.baseline && ctx.baseline.sufficiency === "INSUFFICIENT") {
    lines.push("");
    lines.push("Catatan: baseline historis Anda masih di bawah ambang kecukupan data.");
  }

  appendDataGapLines(lines, ctx);

  return {
    text: lines.join("\n"),
    structured: {
      tenantName: ctx.tenantName,
      salesmanFullName: ctx.salesmanFullName,
      coverageAreas: ctx.coverageAreas,
      businessDate: ctx.businessDate,
      activePeriod: {
        id: ctx.activePeriod.id,
        name: ctx.activePeriod.name,
        startDate: ctx.activePeriod.startDate,
        endDate: ctx.activePeriod.endDate,
      },
      call: ctx.projection.call,
      effectiveCall: ctx.projection.effectiveCall,
      orderCount: ctx.projection.orderCount,
      revenue: ctx.projection.revenue,
      ecRate,
      baselineSufficiency: ctx.baseline?.sufficiency ?? null,
      status: "ACTIVE_PERIOD",
      dataGaps: ctx.dataGaps,
    },
  };
}

export function morningBriefIdempotencyKey(salespersonId: string, businessDate: string): string {
  return `morning_brief:${salespersonId}:${businessDate}`;
}

/**
 * Komposisi Morning Brief satu salesman -- dipakai baik oleh cron proaktif
 * (api/internal/automation/morning-brief/route.ts) MAUPUN jalur on-demand
 * Telegram (/start). Satu-satunya tempat yang memanggil sales-kpi projection/
 * baseline untuk Morning Brief -- mencegah drift antara kedua jalur.
 */
export async function composeMorningBriefForSalesman(
  deps: { salesKpiRepository: SalesKpiRepository; customerDataGapRepository?: CustomerDataGapRepository },
  companyId: string,
  actorId: string,
  salesman: { userId: string; fullName: string; coverageAreas: string[] },
  tenantName: string,
  businessDate: string,
): Promise<MorningBriefContent> {
  const activePeriod = await deps.salesKpiRepository.findActivePeriod(companyId);

  let projection: SalesKpiAchievementProjection | null = null;
  let baseline: SalesKpiCalibrationBaseline | null = null;
  if (activePeriod) {
    const projectionResult = await deps.salesKpiRepository.getAchievementProjection({
      companyId,
      actorId,
      periodId: activePeriod.id,
      salespersonId: salesman.userId,
    });
    projection = projectionResult.outcome === "ok" ? projectionResult.projection : null;

    const baselineResult = await deps.salesKpiRepository.getCalibrationBaseline({
      companyId,
      actorId,
      periodId: activePeriod.id,
      salespersonId: salesman.userId,
    });
    baseline = baselineResult.outcome === "ok" ? baselineResult.baseline : null;
  }

  const dataGaps = deps.customerDataGapRepository
    ? await deps.customerDataGapRepository.getGapCountsForSalesperson(companyId, salesman.userId)
    : null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const customersUrl = dataGaps ? `${appUrl}/dashboard/customers?sales=${salesman.userId}` : null;

  return buildMorningBrief({
    tenantName,
    salesmanFullName: salesman.fullName,
    coverageAreas: salesman.coverageAreas,
    businessDate,
    activePeriod,
    projection,
    baseline,
    dataGaps,
    customersUrl,
  });
}
