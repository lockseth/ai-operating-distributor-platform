// =============================================================================
// KPI Daily Summary -- presenter untuk Owner (WhatsApp channel, dry-run only
// pada phase ini -- lihat dispatch route, tidak pernah mengirim WhatsApp
// nyata). Konten SELALU dari data lib/sales-kpi/* per salesman, dirangkai
// di sini, tidak dihitung ulang.
// =============================================================================

import type { ActiveSalesKpiPeriod, SalesKpiAchievementProjection } from "@/lib/sales-kpi/types";
import type { ChurnRiskLevel } from "@/lib/ai/features/churn-prediction";
import type { UnremittedCollectionRiskLevel } from "@/lib/business-guard/features/unremitted-collection";
import type { CallTimingRiskLevel } from "@/lib/business-guard/features/call-timing-anomaly";
import type { DiscountRiskLevel } from "@/lib/business-guard/features/discount-anomaly";
import type { CollectionRiskLevel } from "@/lib/business-guard/features/collection-risk";
import type { BehaviorChangeRiskLevel } from "@/lib/business-guard/features/behavior-change";
import type { TransactionRiskLevel } from "@/lib/business-guard/features/transaction-risk";
import { formatRupiah } from "@/lib/document-engine/monetary";

export interface KpiDailySummarySalesmanLine {
  salesmanFullName: string;
  projection: SalesKpiAchievementProjection | null;
}

export interface KpiDailySummaryChurnCandidate {
  customerName: string;
  riskLevel: ChurnRiskLevel;
  daysSinceLastOrder: number;
}

export interface KpiDailySummaryUnremittedCandidate {
  collectorName: string;
  customerName: string;
  riskLevel: UnremittedCollectionRiskLevel;
  daysElapsed: number;
}

export interface KpiDailySummaryCallTimingCandidate {
  salespersonName: string;
  callDate: string;
  riskLevel: CallTimingRiskLevel;
  minGapSeconds: number | null;
  tightGapCount: number;
}

export interface KpiDailySummaryDiscountAnomalyCandidate {
  salesName: string;
  riskLevel: DiscountRiskLevel;
  totalRequests: number;
  rejectionRate: number;
}

export interface KpiDailySummaryCollectionRiskCandidate {
  customerName: string;
  riskLevel: CollectionRiskLevel;
  totalOutstandingAmount: number;
  maxAgeDays: number | null;
}

export interface KpiDailySummaryBehaviorChangeCandidate {
  customerName: string;
  riskLevel: BehaviorChangeRiskLevel;
  daysSinceLastOrder: number | null;
}

export interface KpiDailySummaryTransactionRiskCandidate {
  orderNumber: string;
  customerName: string;
  riskLevel: TransactionRiskLevel;
  orderTotalAmount: number;
}

export interface KpiDailySummaryContext {
  tenantName: string;
  businessDate: string;
  activePeriod: ActiveSalesKpiPeriod | null;
  lines: KpiDailySummarySalesmanLine[];
  /**
   * Toko risiko churn HIGH/MEDIUM (lib/ai/features/churn-prediction.ts) --
   * opsional/null kalau pemanggil tidak menyediakan (skip bagian ini, bukan
   * error). Kosong (array 0 elemen) juga skip -- bagian ini HANYA muncul
   * kalau memang ada calon churn, konsisten pola PR Data Toko Kredit di
   * morning-brief.ts.
   */
  churnCandidates?: KpiDailySummaryChurnCandidate[] | null;
  /**
   * Klaim "sudah terima pembayaran" yang belum diformalkan jadi payment
   * claim resmi (Gate P4.18, lib/business-guard/features/unremitted-
   * collection.ts) -- HIGH/MEDIUM saja, pola opsional identik churnCandidates.
   */
  unremittedCandidates?: KpiDailySummaryUnremittedCandidate[] | null;
  /**
   * Hari kunjungan dengan jarak waktu antar-toko mencurigakan (Gate P4.19,
   * lib/business-guard/features/call-timing-anomaly.ts) -- BEDA dari
   * churnCandidates/unremittedCandidates: HANYA HIGH yang dikirim (bukan
   * HIGH+MEDIUM), karena sinyal ini heuristik berbasis aturan, bukan fakta
   * terkonfirmasi -- MEDIUM/LOW di sini artinya "layak dilihat", bukan
   * "anomali terkonfirmasi". Pola opsional identik 2 field lain.
   */
  callTimingCandidates?: KpiDailySummaryCallTimingCandidate[] | null;
  /**
   * Gate P4.20 -- 4 fitur Business Guard yang baru pertama kali dapat jalur
   * WA (Anomali Diskon, Piutang Macet, Perubahan Perilaku, Transaction
   * Risk). HIGH saja untuk keempatnya (heuristik/relatif, konsisten
   * callTimingCandidates) -- SEMUA 6 field opsional Business Guard di file
   * ini (termasuk unremitted/callTiming) sekarang sudah di-dedup di sumber
   * (route automation, lewat evaluateAndPersistAlertState) sebelum sampai
   * ke sini -- builder ini TIDAK tahu/tidak perlu tahu soal anti-spam,
   * cukup terima daftar yang MEMANG layak dikirim hari ini.
   */
  discountAnomalyCandidates?: KpiDailySummaryDiscountAnomalyCandidate[] | null;
  collectionRiskCandidates?: KpiDailySummaryCollectionRiskCandidate[] | null;
  behaviorChangeCandidates?: KpiDailySummaryBehaviorChangeCandidate[] | null;
  transactionRiskCandidates?: KpiDailySummaryTransactionRiskCandidate[] | null;
}

export interface KpiDailySummaryContent {
  text: string;
  structured: Record<string, unknown>;
}

function ecRateOf(projection: SalesKpiAchievementProjection): number | null {
  return projection.call.actual > 0
    ? Math.round((projection.effectiveCall.actual / projection.call.actual) * 100)
    : null;
}

/** Calon churn (HIGH/MEDIUM) -- HANYA muncul kalau ada, pola sama PR Data Toko Kredit di morning-brief.ts. */
function appendChurnLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.churnCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Calon Churn (${candidates.length} toko):`);
  for (const c of candidates) {
    const label = c.riskLevel === "HIGH" ? "Tinggi" : "Sedang";
    lines.push(`${c.customerName} -- risiko ${label}, tidak order ${c.daysSinceLastOrder} hari`);
  }
}

/** Klaim belum diformalkan (Gate P4.18, HIGH/MEDIUM) -- HANYA muncul kalau ada, pola sama appendChurnLines. */
function appendUnremittedLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.unremittedCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Klaim Pembayaran Belum Diformalkan (${candidates.length}):`);
  for (const c of candidates) {
    const label = c.riskLevel === "HIGH" ? "Tinggi" : "Sedang";
    lines.push(`${c.collectorName} -- ${c.customerName}, risiko ${label}, ${c.daysElapsed} hari belum ada klaim pembayaran`);
  }
}

/** Kunjungan mencurigakan (Gate P4.19, HIGH saja) -- HANYA muncul kalau ada, pola sama appendUnremittedLines. */
function appendCallTimingLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.callTimingCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Kunjungan Mencurigakan (${candidates.length}):`);
  for (const c of candidates) {
    const gapLabel = c.minGapSeconds !== null ? `${c.minGapSeconds} detik` : "-";
    lines.push(`${c.salespersonName} -- ${c.callDate}, jarak terketat ${gapLabel}, ${c.tightGapCount} pasang < 2 menit`);
  }
}

/** Anomali diskon (Gate P4.20, HIGH saja) -- HANYA muncul kalau ada, pola sama appendCallTimingLines. */
function appendDiscountAnomalyLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.discountAnomalyCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Anomali Pengajuan Diskon (${candidates.length}):`);
  for (const c of candidates) {
    lines.push(`${c.salesName} -- ${c.totalRequests} pengajuan, ${Math.round(c.rejectionRate * 100)}% ditolak`);
  }
}

/** Piutang macet (Gate P4.20, HIGH saja) -- HANYA muncul kalau ada, pola sama appendCallTimingLines. */
function appendCollectionRiskLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.collectionRiskCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Piutang Berisiko Macet (${candidates.length}):`);
  for (const c of candidates) {
    const ageLabel = c.maxAgeDays !== null ? `${c.maxAgeDays} hari lewat jatuh tempo` : "umur tidak diketahui";
    lines.push(`${c.customerName} -- ${formatRupiah(c.totalOutstandingAmount)}, ${ageLabel}`);
  }
}

/** Perubahan perilaku customer (Gate P4.20, HIGH saja) -- HANYA muncul kalau ada, pola sama appendCallTimingLines. */
function appendBehaviorChangeLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.behaviorChangeCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Perubahan Perilaku Customer (${candidates.length}):`);
  for (const c of candidates) {
    const label = c.daysSinceLastOrder !== null ? `${c.daysSinceLastOrder} hari sejak order terakhir` : "belum pernah order";
    lines.push(`${c.customerName} -- ${label}`);
  }
}

/** Transaction risk (Gate P4.20, HIGH saja) -- HANYA muncul kalau ada, pola sama appendCallTimingLines. */
function appendTransactionRiskLines(lines: string[], ctx: KpiDailySummaryContext): void {
  const candidates = ctx.transactionRiskCandidates;
  if (!candidates || candidates.length === 0) return;

  lines.push("");
  lines.push(`Transaksi Berisiko (${candidates.length}):`);
  for (const c of candidates) {
    lines.push(`${c.orderNumber} -- ${c.customerName}, ${formatRupiah(c.orderTotalAmount)}`);
  }
}

export function buildKpiDailySummary(ctx: KpiDailySummaryContext): KpiDailySummaryContent {
  const lines: string[] = [];
  lines.push(`${ctx.tenantName} -- KPI Daily Summary ${ctx.businessDate}`);
  lines.push("");

  if (!ctx.activePeriod) {
    lines.push("Periode KPI belum diaktifkan. Belum ada target resmi untuk ditampilkan.");
    appendChurnLines(lines, ctx);
    appendUnremittedLines(lines, ctx);
    appendCallTimingLines(lines, ctx);
    appendDiscountAnomalyLines(lines, ctx);
    appendCollectionRiskLines(lines, ctx);
    appendBehaviorChangeLines(lines, ctx);
    appendTransactionRiskLines(lines, ctx);
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        businessDate: ctx.businessDate,
        activePeriod: null,
        status: "NO_ACTIVE_PERIOD",
        salesmen: [],
        churnCandidates: ctx.churnCandidates ?? [],
        unremittedCandidates: ctx.unremittedCandidates ?? [],
        callTimingCandidates: ctx.callTimingCandidates ?? [],
        discountAnomalyCandidates: ctx.discountAnomalyCandidates ?? [],
        collectionRiskCandidates: ctx.collectionRiskCandidates ?? [],
        behaviorChangeCandidates: ctx.behaviorChangeCandidates ?? [],
        transactionRiskCandidates: ctx.transactionRiskCandidates ?? [],
      },
    };
  }

  lines.push(`Periode: ${ctx.activePeriod.name}`);
  lines.push("");

  const structuredSalesmen: Record<string, unknown>[] = [];

  for (const line of ctx.lines) {
    if (!line.projection || (line.projection.call.target === null && line.projection.effectiveCall.target === null)) {
      lines.push(`${line.salesmanFullName}: Data belum cukup -- target belum ditetapkan`);
      structuredSalesmen.push({ salesmanFullName: line.salesmanFullName, status: "TARGET_NOT_SET" });
      continue;
    }

    const p = line.projection;
    const ecRate = ecRateOf(p);
    const callText =
      p.call.target !== null ? `Call ${p.call.actual}/${p.call.target} (${p.call.achievementPercentage}%)` : "Call: Data belum cukup";
    const ecText =
      p.effectiveCall.target !== null
        ? `EC ${p.effectiveCall.actual}/${p.effectiveCall.target} (${p.effectiveCall.achievementPercentage}%)`
        : "EC: Data belum cukup";

    lines.push(`${line.salesmanFullName}: ${callText}, ${ecText}, EC Rate ${ecRate !== null ? `${ecRate}%` : "Data belum cukup"}`);

    structuredSalesmen.push({
      salesmanFullName: line.salesmanFullName,
      call: p.call,
      effectiveCall: p.effectiveCall,
      ecRate,
      status: "TARGET_SET",
    });
  }

  appendChurnLines(lines, ctx);
  appendUnremittedLines(lines, ctx);
  appendCallTimingLines(lines, ctx);
  appendDiscountAnomalyLines(lines, ctx);
  appendCollectionRiskLines(lines, ctx);
  appendBehaviorChangeLines(lines, ctx);
  appendTransactionRiskLines(lines, ctx);

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
      churnCandidates: ctx.churnCandidates ?? [],
      unremittedCandidates: ctx.unremittedCandidates ?? [],
      callTimingCandidates: ctx.callTimingCandidates ?? [],
      discountAnomalyCandidates: ctx.discountAnomalyCandidates ?? [],
      collectionRiskCandidates: ctx.collectionRiskCandidates ?? [],
      behaviorChangeCandidates: ctx.behaviorChangeCandidates ?? [],
      transactionRiskCandidates: ctx.transactionRiskCandidates ?? [],
    },
  };
}

export function kpiDailySummaryIdempotencyKey(companyId: string, businessDate: string): string {
  return `kpi_daily_summary:${companyId}:${businessDate}`;
}
