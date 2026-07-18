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
}

export interface MorningBriefContent {
  text: string;
  structured: Record<string, unknown>;
}

function formatLine(target: number | null, actual: number, percentage: number | null): string {
  if (target === null) return `${actual} (Data belum cukup -- target belum ditetapkan)`;
  return `${actual}/${target} (${percentage ?? 0}%)`;
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
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        salesmanFullName: ctx.salesmanFullName,
        coverageAreas: ctx.coverageAreas,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
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

  const ecRate =
    ctx.projection.call.actual > 0
      ? Math.round((ctx.projection.effectiveCall.actual / ctx.projection.call.actual) * 100)
      : null;
  lines.push(`EC Rate: ${ecRate !== null ? `${ecRate}% (insight, bukan KPI)` : "Data belum cukup"}`);

  if (ctx.baseline && ctx.baseline.sufficiency === "INSUFFICIENT") {
    lines.push("");
    lines.push("Catatan: baseline historis Anda masih di bawah ambang kecukupan data.");
  }

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
      ecRate,
      baselineSufficiency: ctx.baseline?.sufficiency ?? null,
      status: "ACTIVE_PERIOD",
    },
  };
}

export function morningBriefIdempotencyKey(salespersonId: string, businessDate: string): string {
  return `morning_brief:${salespersonId}:${businessDate}`;
}
