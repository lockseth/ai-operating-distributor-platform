import { generateCollectionRiskReport, generateDiscountAnomalyReport } from "@/lib/business-guard/engine";
import type {
  ExecutiveContributor,
  ModuleContribution,
  HealthComponent,
  ExecutiveInsight,
  ExecutiveAction,
} from "../types";

// =============================================================================
// Contributor: Business Guard AI -- Collection Risk (Milestone 3, lihat
// lib/business-guard/features/collection-risk.ts + engine.ts) DAN Sales Risk/
// discount anomaly (lib/business-guard/features/discount-anomaly.ts, sudah
// lama LOCKED & hidup di /dashboard/risk, baru sekarang ikut dikontribusikan
// ke Executive Intelligence). Tidak ada logic scoring baru sama sekali di
// sini -- murni menyambungkan dua report yang sudah ada ke kontrak
// ModuleContribution, pola sama persis dengan Collection Risk.
// =============================================================================

function formatIDR(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `Rp${(n / 1_000_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000) return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

export const businessGuardContributor: ExecutiveContributor = {
  module: "business_guard",
  moduleLabel: "Business Guard",

  async contribute({ companyId }): Promise<ModuleContribution> {
    const [collectionReport, discountReport] = await Promise.all([
      generateCollectionRiskReport(companyId),
      generateDiscountAnomalyReport(companyId),
    ]);

    const health: HealthComponent[] = [];
    if (collectionReport.length > 0) {
      const healthyCount = collectionReport.filter((r) => r.risk_level === "NONE" || r.risk_level === "LOW").length;
      const completePct = Math.round((healthyCount / collectionReport.length) * 100);
      health.push({
        key: "collection_risk",
        label: "Kualitas Piutang",
        score: completePct,
        weight: 2,
        reason: `${healthyCount} dari ${collectionReport.length} customer berpiutang dalam kondisi aman/rendah risiko`,
        trend: completePct >= 90 ? "up" : completePct >= 60 ? "neutral" : "down",
      });
    }
    if (discountReport.length > 0) {
      const healthyCount = discountReport.filter((r) => r.risk_level === "NONE" || r.risk_level === "LOW").length;
      const completePct = Math.round((healthyCount / discountReport.length) * 100);
      health.push({
        key: "sales_discount_risk",
        label: "Kewajaran Diskon Sales",
        score: completePct,
        weight: 2,
        reason: `${healthyCount} dari ${discountReport.length} sales dengan pola pengajuan harga khusus wajar`,
        trend: completePct >= 90 ? "up" : completePct >= 60 ? "neutral" : "down",
      });
    }

    const insights: ExecutiveInsight[] = [];
    const actions: ExecutiveAction[] = [];

    const high = collectionReport.filter((r) => r.risk_level === "HIGH");
    const medium = collectionReport.filter((r) => r.risk_level === "MEDIUM");

    if (high.length > 0) {
      const names = high.map((r) => r.customer_name).slice(0, 5).join(", ");
      const totalAtRisk = high.reduce((s, r) => s + r.total_outstanding_amount, 0);
      insights.push({
        module: "business_guard",
        severity: "critical",
        title: `${high.length} customer piutang berisiko tinggi macet`,
        narrative: `${names}${high.length > 5 ? ", …" : ""} -- total piutang berisiko ${formatIDR(totalAtRisk)}.`,
      });
      actions.push({
        module: "business_guard",
        priority: "URGENT",
        action: "Tindak lanjuti piutang berisiko tinggi",
        rationale: `${high.length} customer, total ${formatIDR(totalAtRisk)} berpotensi macet`,
        href: "/dashboard/risk",
      });
    }

    if (medium.length > 0) {
      const names = medium.map((r) => r.customer_name).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "warning",
        title: `${medium.length} customer piutang perlu follow-up`,
        narrative: `${names}${medium.length > 5 ? ", …" : ""} -- piutang mulai menua, follow-up sebelum jadi risiko tinggi.`,
      });
      actions.push({
        module: "business_guard",
        priority: "HIGH",
        action: "Follow-up piutang yang mulai menua",
        rationale: `${medium.length} customer masuk kategori risiko sedang`,
        href: "/dashboard/risk",
      });
    }

    const salesHigh = discountReport.filter((r) => r.risk_level === "HIGH");
    const salesMedium = discountReport.filter((r) => r.risk_level === "MEDIUM");

    if (salesHigh.length > 0) {
      const names = salesHigh.map((r) => r.sales_name).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "critical",
        title: `${salesHigh.length} sales dengan pola pengajuan diskon anomali tinggi`,
        narrative: `${names}${salesHigh.length > 5 ? ", …" : ""} -- pengajuan harga khusus di luar kewajaran dibanding sales lain.`,
      });
      actions.push({
        module: "business_guard",
        priority: "URGENT",
        action: "Tinjau pengajuan harga khusus sales berisiko tinggi",
        rationale: `${salesHigh.length} sales dengan pola anomali diskon`,
        href: "/dashboard/risk",
      });
    }

    if (salesMedium.length > 0) {
      const names = salesMedium.map((r) => r.sales_name).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "warning",
        title: `${salesMedium.length} sales perlu dipantau pola diskonnya`,
        narrative: `${names}${salesMedium.length > 5 ? ", …" : ""} -- pengajuan harga khusus lebih sering/dalam dari rata-rata.`,
      });
      actions.push({
        module: "business_guard",
        priority: "HIGH",
        action: "Pantau pengajuan diskon sales bulan ini",
        rationale: `${salesMedium.length} sales masuk kategori risiko sedang`,
        href: "/dashboard/risk",
      });
    }

    return {
      module: "business_guard",
      moduleLabel: "Business Guard",
      active: true,
      health,
      kpis: [],
      insights,
      actions,
    };
  },
};
