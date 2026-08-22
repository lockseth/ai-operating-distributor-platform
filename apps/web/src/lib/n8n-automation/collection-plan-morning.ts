// =============================================================================
// Rencana Penagihan Pagi -- presenter untuk Owner (WhatsApp channel, dry-run
// only pada phase ini -- lihat dispatch route, tidak pernah mengirim WhatsApp
// nyata). Fase B redesain Laporan Sales, varian PAGI: bukan hasil kerja,
// tapi RENCANA hari itu -- toko mana yang mau ditagih. Definisi "toko yang
// mau ditagih" dikonfirmasi Founder 2026-08-22: overdue H+1 (invoice lewat
// jatuh tempo minimal 1 hari) DAN/ATAU janji bayar H+1 (janji bayar masih
// 'open' tapi sudah lewat tanggal janji minimal 1 hari). Konten SELALU dari
// lib/finance/getCollectionPlanBySalesperson, dirangkai di sini, tidak
// dihitung ulang.
// =============================================================================

import { formatRupiah } from "@/lib/document-engine/monetary";

export interface CollectionPlanEntryLine {
  customerName: string;
  invoiceNumber: string;
  outstandingBalance: number;
  isOverdue: boolean;
  daysOverdue: number | null;
  hasOverduePromise: boolean;
  daysSincePromise: number | null;
  promisedAmount: number | null;
}

export interface CollectionPlanSalesmanLine {
  salesmanFullName: string;
  entries: CollectionPlanEntryLine[];
}

export interface CollectionPlanMorningContext {
  tenantName: string;
  businessDate: string;
  lines: CollectionPlanSalesmanLine[];
}

export interface CollectionPlanMorningContent {
  text: string;
  structured: Record<string, unknown>;
}

function reasonText(e: CollectionPlanEntryLine): string {
  const parts: string[] = [];
  if (e.isOverdue) parts.push(`overdue ${e.daysOverdue} hari`);
  if (e.hasOverduePromise) parts.push(`janji bayar lewat ${e.daysSincePromise} hari (${formatRupiah(e.promisedAmount ?? 0)})`);
  return parts.join(", ");
}

export function buildCollectionPlanMorning(ctx: CollectionPlanMorningContext): CollectionPlanMorningContent {
  const lines: string[] = [];
  lines.push(`${ctx.tenantName} -- Rencana Penagihan ${ctx.businessDate}`);
  lines.push("");

  const salesmenWithTargets = ctx.lines.filter((l) => l.entries.length > 0);

  if (salesmenWithTargets.length === 0) {
    lines.push("Tidak ada toko yang perlu ditagih hari ini -- tidak ada invoice overdue maupun janji bayar yang terlewat.");
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        businessDate: ctx.businessDate,
        status: "NO_TARGETS",
        salesmen: [],
      },
    };
  }

  const structuredSalesmen: Record<string, unknown>[] = [];

  for (const line of salesmenWithTargets) {
    lines.push(`${line.salesmanFullName} (${line.entries.length} toko):`);
    for (const e of line.entries) {
      lines.push(`  ${e.customerName} -- ${e.invoiceNumber} (${formatRupiah(e.outstandingBalance)}) -- ${reasonText(e)}`);
    }
    structuredSalesmen.push({ salesmanFullName: line.salesmanFullName, entries: line.entries });
  }

  return {
    text: lines.join("\n"),
    structured: {
      tenantName: ctx.tenantName,
      businessDate: ctx.businessDate,
      status: "HAS_TARGETS",
      salesmen: structuredSalesmen,
    },
  };
}

export function collectionPlanMorningIdempotencyKey(companyId: string, businessDate: string): string {
  return `collection_plan_morning:${companyId}:${businessDate}`;
}

export interface CollectionPlanForSalesmanContext {
  tenantName: string;
  salesmanFullName: string;
  businessDate: string;
  entries: CollectionPlanEntryLine[];
}

/**
 * Versi personal Rencana Penagihan untuk SATU sales -- Founder minta
 * 2026-08-22 supaya sales juga tahu toko mana yang perlu DIA sendiri
 * tagih (sebelumnya cuma Owner yang dapat rekap semua sales jadi satu
 * pesan, lihat buildCollectionPlanMorning di atas -- TETAP dipertahankan
 * apa adanya, ini TAMBAHAN bukan pengganti).
 */
export function buildCollectionPlanForSalesman(ctx: CollectionPlanForSalesmanContext): CollectionPlanMorningContent {
  const lines: string[] = [];
  lines.push(`Selamat pagi, ${ctx.salesmanFullName}`);
  lines.push(`${ctx.tenantName} -- Rencana Penagihan Anda ${ctx.businessDate}`);
  lines.push("");

  if (ctx.entries.length === 0) {
    lines.push("Tidak ada toko yang perlu Anda tagih hari ini.");
    return {
      text: lines.join("\n"),
      structured: {
        tenantName: ctx.tenantName,
        salesmanFullName: ctx.salesmanFullName,
        businessDate: ctx.businessDate,
        status: "NO_TARGETS",
        entries: [],
      },
    };
  }

  lines.push(`${ctx.entries.length} toko perlu ditagih hari ini:`);
  for (const e of ctx.entries) {
    lines.push(`  ${e.customerName} -- ${e.invoiceNumber} (${formatRupiah(e.outstandingBalance)}) -- ${reasonText(e)}`);
  }

  return {
    text: lines.join("\n"),
    structured: {
      tenantName: ctx.tenantName,
      salesmanFullName: ctx.salesmanFullName,
      businessDate: ctx.businessDate,
      status: "HAS_TARGETS",
      entries: ctx.entries,
    },
  };
}

export function collectionPlanForSalesmanIdempotencyKey(salespersonId: string, businessDate: string): string {
  return `collection_plan_morning_salesman:${salespersonId}:${businessDate}`;
}
