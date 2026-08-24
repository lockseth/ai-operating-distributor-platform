// =============================================================================
// Milestone 1 (fondasi chatbot bisnis Owner) -- ubah OwnerBusinessSnapshot
// (data mentah dari snapshot.ts) jadi teks naratif siap pakai sebagai
// context/system prompt LLM. Pure function (tanpa I/O), tidak menyentuh
// packages/ai sama sekali -- murni format teks, testable tanpa API key.
// =============================================================================

import { formatRupiah } from "@/lib/document-engine/monetary";
import { WALUYO_SALES_KPI_DEFINITIONS } from "@/lib/sales-kpi/service";
import type { SalesKpiCode } from "@/lib/sales-kpi/types";
import type { RiskLevelCounts } from "./aggregates";
import type { OwnerBusinessSnapshot } from "./snapshot";

const KPI_LABEL: Partial<Record<SalesKpiCode, string>> = Object.fromEntries(
  WALUYO_SALES_KPI_DEFINITIONS.map((d) => [d.code, d.name]),
);
const KPI_UNIT: Partial<Record<SalesKpiCode, string>> = Object.fromEntries(
  WALUYO_SALES_KPI_DEFINITIONS.map((d) => [d.code, d.unit]),
);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

function formatKpiValue(code: SalesKpiCode, value: number): string {
  return KPI_UNIT[code] === "IDR" ? formatRupiah(value) : value.toLocaleString("id-ID");
}

function isRiskFree(counts: RiskLevelCounts): boolean {
  return counts.high === 0 && counts.medium === 0 && counts.low === 0;
}

export function buildOwnerChatContext(snapshot: OwnerBusinessSnapshot): string {
  const lines: string[] = [];

  lines.push(`Ringkasan bisnis periode ${formatDate(snapshot.dateRange.from)} - ${formatDate(snapshot.dateRange.to)}.`);
  lines.push("");

  lines.push("PRODUK PALING LAKU:");
  if (snapshot.topProducts.length === 0) {
    lines.push("- Belum ada data penjualan produk pada periode ini.");
  } else {
    snapshot.topProducts.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.product_name} -- ${p.total_quantity} unit terjual, omzet ${formatRupiah(p.total_revenue)}`);
    });
  }
  lines.push("");

  lines.push("TOKO DENGAN OMZET TERBESAR:");
  if (snapshot.topCustomers.length === 0) {
    lines.push("- Belum ada data order customer pada periode ini.");
  } else {
    snapshot.topCustomers.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.customer_name} -- ${c.order_count} order, omzet ${formatRupiah(c.total_revenue)}`);
    });
  }
  lines.push("");

  lines.push("STATUS KPI PERIODE AKTIF:");
  if (!snapshot.kpiStatus) {
    lines.push("- Belum ada periode KPI aktif yang di-set.");
  } else {
    (Object.keys(snapshot.kpiStatus) as SalesKpiCode[]).forEach((code) => {
      const agg = snapshot.kpiStatus![code];
      const label = KPI_LABEL[code] ?? code;
      if (!agg.hasTarget) {
        lines.push(`- ${label}: belum ada target di-set (pencapaian sejauh ini ${formatKpiValue(code, agg.achieved)})`);
      } else {
        const pct = agg.target > 0 ? Math.round((agg.achieved / agg.target) * 100) : 0;
        lines.push(`- ${label}: ${formatKpiValue(code, agg.achieved)} dari target ${formatKpiValue(code, agg.target)} (${pct}%)`);
      }
    });
  }
  lines.push("");

  lines.push("RINGKASAN RISIKO BISNIS (Business Guard):");
  const riskEntries: [string, RiskLevelCounts][] = [
    ["Kewajaran Diskon Sales", snapshot.riskSummary.salesRisk],
    ["Piutang Berisiko Macet", snapshot.riskSummary.collectionRisk],
    ["Perubahan Perilaku Customer", snapshot.riskSummary.behaviorChange],
    ["Transaksi Janggal (30 Hari Terakhir)", snapshot.riskSummary.transactionRisk],
    ["Klaim Pembayaran Belum Diformalkan", snapshot.riskSummary.unremittedCollection],
    ["Kunjungan Mencurigakan (Jarak Waktu)", snapshot.riskSummary.callTiming],
  ];
  riskEntries.forEach(([label, counts]) => {
    lines.push(
      isRiskFree(counts)
        ? `- ${label}: aman, tidak ada yang perlu perhatian.`
        : `- ${label}: ${counts.high} risiko tinggi, ${counts.medium} risiko sedang, ${counts.low} risiko rendah.`,
    );
  });

  return lines.join("\n");
}
