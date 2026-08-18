import {
  generateCollectionRiskReport,
  generateDiscountAnomalyReport,
  generateBehaviorChangeReport,
  generateTransactionRiskReport,
} from "@/lib/business-guard/engine";
import type {
  ExecutiveContributor,
  ModuleContribution,
  HealthComponent,
  ExecutiveInsight,
  ExecutiveAction,
} from "../types";

// =============================================================================
// Contributor: Business Guard AI -- Collection Risk, Sales Risk/discount
// anomaly, Behavior Change, dan Transaction Risk Score (Gate P4.10, slice
// terakhir -- lib/business-guard/features/transaction-risk.ts + engine.ts).
// Tidak ada logic scoring baru sama sekali di sini -- murni menyambungkan
// report yang sudah ada ke kontrak ModuleContribution, pola sama persis
// dengan 3 slice sebelumnya.
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
    const [collectionReport, discountReport, behaviorReport, transactionReport] = await Promise.all([
      generateCollectionRiskReport(companyId),
      generateDiscountAnomalyReport(companyId),
      generateBehaviorChangeReport(companyId),
      generateTransactionRiskReport(companyId),
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
    if (behaviorReport.length > 0) {
      const healthyCount = behaviorReport.filter((r) => r.risk_level === "NONE" || r.risk_level === "LOW").length;
      const completePct = Math.round((healthyCount / behaviorReport.length) * 100);
      health.push({
        key: "customer_behavior_change",
        label: "Stabilitas Perilaku Customer",
        score: completePct,
        weight: 1,
        reason: `${healthyCount} dari ${behaviorReport.length} customer dengan pola order/PIC stabil, tidak ada perubahan mencurigakan`,
        trend: completePct >= 90 ? "up" : completePct >= 60 ? "neutral" : "down",
      });
    }
    if (transactionReport.length > 0) {
      const healthyCount = transactionReport.filter((r) => r.risk_level === "NONE" || r.risk_level === "LOW").length;
      const completePct = Math.round((healthyCount / transactionReport.length) * 100);
      health.push({
        key: "transaction_risk",
        label: "Kewajaran Transaksi (30 Hari)",
        score: completePct,
        weight: 1,
        reason: `${healthyCount} dari ${transactionReport.length} order 30 hari terakhir dalam pola nilai/kuantitas wajar`,
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

    const behaviorHigh = behaviorReport.filter((r) => r.risk_level === "HIGH");
    const behaviorMedium = behaviorReport.filter((r) => r.risk_level === "MEDIUM");

    if (behaviorHigh.length > 0) {
      const names = behaviorHigh.map((r) => r.customer_name).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "critical",
        title: `${behaviorHigh.length} customer dengan perubahan perilaku mencurigakan`,
        narrative: `${names}${behaviorHigh.length > 5 ? ", …" : ""} -- pola order menurun drastis dan/atau PIC berganti dari kebiasaan.`,
      });
      actions.push({
        module: "business_guard",
        priority: "URGENT",
        action: "Cek langsung customer dengan perubahan perilaku tinggi",
        rationale: `${behaviorHigh.length} customer, pola order/PIC berubah drastis dari baseline`,
        href: "/dashboard/risk",
      });
    }

    if (behaviorMedium.length > 0) {
      const names = behaviorMedium.map((r) => r.customer_name).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "warning",
        title: `${behaviorMedium.length} customer perlu dipantau perubahan perilakunya`,
        narrative: `${names}${behaviorMedium.length > 5 ? ", …" : ""} -- mulai ada perubahan pola order/PIC dari kebiasaan.`,
      });
      actions.push({
        module: "business_guard",
        priority: "HIGH",
        action: "Pantau customer dengan perubahan perilaku sedang",
        rationale: `${behaviorMedium.length} customer masuk kategori risiko sedang`,
        href: "/dashboard/risk",
      });
    }

    const txHigh = transactionReport.filter((r) => r.risk_level === "HIGH");
    const txMedium = transactionReport.filter((r) => r.risk_level === "MEDIUM");

    if (txHigh.length > 0) {
      const orderNumbers = txHigh.map((r) => r.order_number).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "critical",
        title: `${txHigh.length} order dengan skor risiko transaksi tinggi`,
        narrative: `${orderNumbers}${txHigh.length > 5 ? ", …" : ""} -- nilai/kuantitas jauh di luar kebiasaan, cek sebelum diproses lebih lanjut.`,
      });
      actions.push({
        module: "business_guard",
        priority: "URGENT",
        action: "Cek ulang order dengan skor risiko transaksi tinggi",
        rationale: `${txHigh.length} order dalam 30 hari terakhir, nilai/kuantitas anomali`,
        href: "/dashboard/risk",
      });
    }

    if (txMedium.length > 0) {
      const orderNumbers = txMedium.map((r) => r.order_number).slice(0, 5).join(", ");
      insights.push({
        module: "business_guard",
        severity: "warning",
        title: `${txMedium.length} order perlu konfirmasi ulang`,
        narrative: `${orderNumbers}${txMedium.length > 5 ? ", …" : ""} -- nilai/kuantitas di atas kebiasaan, konfirmasi sebelum dikirim.`,
      });
      actions.push({
        module: "business_guard",
        priority: "HIGH",
        action: "Konfirmasi order dengan skor risiko transaksi sedang",
        rationale: `${txMedium.length} order masuk kategori risiko sedang`,
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
