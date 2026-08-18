import { createClient } from "@/lib/supabase/server";
import { SupabaseCustomerDataGapRepository } from "@/lib/customers/data-completeness";
import type {
  ExecutiveContributor,
  ModuleContribution,
  HealthComponent,
  ExecutiveInsight,
  ExecutiveAction,
} from "../types";

// =============================================================================
// Contributor: Customer Health -- kelengkapan data toko (foto depan toko,
// titik GPS) untuk toko KREDIT saja (keputusan Pak Waluyo: toko CASH tidak
// diribetkan sama sekali, tapi toko kredit wajar diminta lengkap karena
// distributor menanggung risiko piutang di sana). Definisi "kredit" ada di
// lib/customers/data-completeness.ts.
// =============================================================================

export const customerHealthContributor: ExecutiveContributor = {
  module: "customer_health",
  moduleLabel: "Customer Health",

  async contribute({ companyId }): Promise<ModuleContribution> {
    const supabase = await createClient();
    const repo = new SupabaseCustomerDataGapRepository(supabase);

    const [totalCredit, incompleteCount, gapsBySales] = await Promise.all([
      repo.getTotalCreditCount(companyId),
      repo.getTotalIncompleteCount(companyId),
      repo.getGapCountsBySalesperson(companyId),
    ]);

    const health: HealthComponent[] = [];
    if (totalCredit > 0) {
      const completePct = Math.round(((totalCredit - incompleteCount) / totalCredit) * 100);
      health.push({
        key: "store_data_completeness",
        label: "Kelengkapan Data Toko Kredit",
        score: completePct,
        weight: 1,
        reason: `${totalCredit - incompleteCount} dari ${totalCredit} toko kredit sudah lengkap foto + GPS`,
        trend: completePct >= 90 ? "up" : completePct >= 60 ? "neutral" : "down",
      });
    }

    const insights: ExecutiveInsight[] = [];
    const actions: ExecutiveAction[] = [];

    const totalMissingPhoto = gapsBySales.reduce((s, g) => s + g.missingPhoto, 0);
    const totalMissingGps = gapsBySales.reduce((s, g) => s + g.missingGps, 0);

    if (totalMissingPhoto > 0) {
      const breakdown = gapsBySales
        .filter((g) => g.missingPhoto > 0)
        .map((g) => `${g.salesName} ${g.missingPhoto}`)
        .join(", ");
      insights.push({
        module: "customer_health",
        severity: "info",
        title: `${totalMissingPhoto} toko kredit belum ada foto depan toko`,
        narrative: `Rincian per sales: ${breakdown}.`,
      });
      actions.push({
        module: "customer_health",
        priority: "MEDIUM",
        action: "Lengkapi foto depan toko kredit yang kosong",
        rationale: `${totalMissingPhoto} toko kredit belum ada foto -- ${breakdown}`,
        href: "/dashboard/customers?data_gap=photo",
      });
    }

    if (totalMissingGps > 0) {
      const breakdown = gapsBySales
        .filter((g) => g.missingGps > 0)
        .map((g) => `${g.salesName} ${g.missingGps}`)
        .join(", ");
      insights.push({
        module: "customer_health",
        severity: "info",
        title: `${totalMissingGps} toko kredit belum ada titik GPS`,
        narrative: `Rincian per sales: ${breakdown}.`,
      });
      actions.push({
        module: "customer_health",
        priority: "MEDIUM",
        action: "Lengkapi titik GPS toko kredit yang kosong",
        rationale: `${totalMissingGps} toko kredit belum ada GPS -- ${breakdown}`,
        href: "/dashboard/customers?data_gap=gps",
      });
    }

    return {
      module: "customer_health",
      moduleLabel: "Customer Health",
      active: true,
      health,
      kpis: [],
      insights,
      actions,
    };
  },
};
