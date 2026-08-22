// =============================================================================
// Laporan Sales Sore -- presenter untuk Owner (WhatsApp channel, dry-run only
// pada phase ini -- lihat dispatch route, tidak pernah mengirim WhatsApp
// nyata). Fase B redesain Laporan Sales (Gate P4.03 Fase A): hasil kerja
// HARI ITU per sales -- EC-to-transaksi (bukan cuma jumlah kunjungan),
// Omzet vs target, dan ringkasan Tagihan (piutang outstanding/overdue).
// Konten SELALU dari data lib/sales-kpi/* + lib/finance/* per salesman,
// dirangkai di sini, tidak dihitung ulang.
// =============================================================================

import type { ActiveSalesKpiPeriod, SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";
import { formatCurrencyLine, formatLine } from "./morning-brief";
import { formatRupiah } from "@/lib/document-engine/monetary";

export interface SalesReportAfternoonTagihan {
  outstandingCount: number;
  outstandingTotal: number;
  overdueCount: number;
}

export interface SalesReportAfternoonSalesmanLine {
  salesmanFullName: string;
  projection: SalesKpiAchievementProjection | null;
  tagihan: SalesReportAfternoonTagihan;
}

export interface SalesReportAfternoonContext {
  tenantName: string;
  businessDate: string;
  activePeriod: ActiveSalesKpiPeriod | null;
  lines: SalesReportAfternoonSalesmanLine[];
}

export interface SalesReportAfternoonContent {
  text: string;
  structured: Record<string, unknown>;
}

function ecToTransaksiText(p: SalesKpiAchievementProjection): string {
  if (p.effectiveCall.actual === 0) return "EC-to-Transaksi: belum ada kunjungan efektif hari ini";
  const conversionPct = Math.round((p.orderCount.actual / p.effectiveCall.actual) * 100);
  return `EC-to-Transaksi: ${p.effectiveCall.actual} kunjungan -> ${p.orderCount.actual} transaksi (${conversionPct}%)`;
}

function tagihanText(t: SalesReportAfternoonTagihan): string {
  if (t.outstandingCount === 0) return "Tagihan: tidak ada piutang outstanding";
  const overdueText = t.overdueCount > 0 ? `, ${t.overdueCount} lewat jatuh tempo` : "";
  return `Tagihan: ${t.outstandingCount} invoice outstanding (${formatRupiah(t.outstandingTotal)})${overdueText}`;
}

export function buildSalesReportAfternoon(ctx: SalesReportAfternoonContext): SalesReportAfternoonContent {
  const lines: string[] = [];
  lines.push(`${ctx.tenantName} -- Laporan Sales Sore ${ctx.businessDate}`);
  lines.push("");

  if (!ctx.activePeriod) {
    lines.push("Periode KPI belum diaktifkan. Belum ada target resmi untuk ditampilkan.");
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
        salesmen: [],
      },
    };
  }

  lines.push(`Periode: ${ctx.activePeriod.name}`);
  lines.push("");

  const structuredSalesmen: Record<string, unknown>[] = [];

  for (const line of ctx.lines) {
    if (!line.projection || (line.projection.orderCount.target === null && line.projection.revenue.target === null)) {
      lines.push(`${line.salesmanFullName}: Data belum cukup -- target belum ditetapkan`);
      lines.push(`  ${tagihanText(line.tagihan)}`);
      structuredSalesmen.push({
        salesmanFullName: line.salesmanFullName,
        tagihan: line.tagihan,
        status: "TARGET_NOT_SET",
      });
      continue;
    }

    const p = line.projection;
    lines.push(`${line.salesmanFullName}:`);
    lines.push(`  ${ecToTransaksiText(p)}`);
    lines.push(`  Transaksi ${formatLine(p.orderCount.target, p.orderCount.actual, p.orderCount.achievementPercentage)}`);
    lines.push(`  Omzet ${formatCurrencyLine(p.revenue.target, Math.round(p.revenue.actual), p.revenue.achievementPercentage)}`);
    lines.push(`  ${tagihanText(line.tagihan)}`);

    structuredSalesmen.push({
      salesmanFullName: line.salesmanFullName,
      effectiveCall: p.effectiveCall,
      orderCount: p.orderCount,
      revenue: p.revenue,
      tagihan: line.tagihan,
      status: "TARGET_SET",
    });
  }

  return {
    text: lines.join("\n"),
    structured: {
      tenantName: ctx.tenantName,
      businessDate: ctx.businessDate,
      activePeriod: {
        id: ctx.activePeriod.id,
        name: ctx.activePeriod.name,
        startDate: ctx.activePeriod.startDate,
        endDate: ctx.activePeriod.endDate,
      },
      status: "ACTIVE_PERIOD",
      salesmen: structuredSalesmen,
    },
  };
}

export function salesReportAfternoonIdempotencyKey(companyId: string, businessDate: string): string {
  return `sales_report_afternoon:${companyId}:${businessDate}`;
}
