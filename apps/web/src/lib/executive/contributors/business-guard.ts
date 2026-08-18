import { generateCollectionRiskReport } from "@/lib/business-guard/engine";
import type {
  ExecutiveContributor,
  ModuleContribution,
  HealthComponent,
  ExecutiveInsight,
  ExecutiveAction,
} from "../types";

// =============================================================================
// Contributor: Business Guard AI -- Milestone 3 dari Collection Risk (lihat
// lib/business-guard/features/collection-risk.ts + engine.ts). Sales Risk
// (discount anomaly) SENGAJA belum ikut dikontribusikan ke sini -- masih
// hanya tampil di halaman /dashboard/risk sendiri, di luar scope perubahan
// ini (tidak diminta, tidak disentuh).
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
    const report = await generateCollectionRiskReport(companyId);

    const health: HealthComponent[] = [];
    if (report.length > 0) {
      const healthyCount = report.filter((r) => r.risk_level === "NONE" || r.risk_level === "LOW").length;
      const completePct = Math.round((healthyCount / report.length) * 100);
      health.push({
        key: "collection_risk",
        label: "Kualitas Piutang",
        score: completePct,
        weight: 2,
        reason: `${healthyCount} dari ${report.length} customer berpiutang dalam kondisi aman/rendah risiko`,
        trend: completePct >= 90 ? "up" : completePct >= 60 ? "neutral" : "down",
      });
    }

    const insights: ExecutiveInsight[] = [];
    const actions: ExecutiveAction[] = [];

    const high = report.filter((r) => r.risk_level === "HIGH");
    const medium = report.filter((r) => r.risk_level === "MEDIUM");

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
