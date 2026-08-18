import { flowsalesContributor } from "./contributors/flowsales";
import { customerHealthContributor } from "./contributors/customer-health";
import { businessGuardContributor } from "./contributors/business-guard";
import {
  collectionContributor,
  whatsappContributor,
  warehouseContributor,
} from "./contributors/pending";
import { buildExecutiveBriefing } from "./briefing";
import type {
  ExecutiveContributor,
  ExecutiveOverview,
  HealthSummary,
  ModuleContribution,
} from "./types";

// =============================================================================
// Executive Service Layer — agregator command center (Constitution L13).
// Mendaftarkan contributor per modul, menggabungkan kontribusinya menjadi
// satu ExecutiveOverview: health score, KPI, insight, action, dan briefing.
// Modul baru cukup ditambahkan ke CONTRIBUTORS — halaman tidak berubah.
// =============================================================================

const CONTRIBUTORS: ExecutiveContributor[] = [
  flowsalesContributor,
  customerHealthContributor,
  collectionContributor,
  businessGuardContributor,
  whatsappContributor,
  warehouseContributor,
];

const PRIORITY_ORDER = { URGENT: 0, HIGH: 1, MEDIUM: 2 } as const;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

function summarizeHealth(contributions: ModuleContribution[]): HealthSummary {
  const components = contributions.flatMap((c) => c.health);
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : Math.round(components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight);

  const { label, tone } =
    components.length === 0
      ? { label: "Belum Ada Data", tone: "amber" as const }
      : score >= 80
        ? { label: "Bisnis Sehat", tone: "green" as const }
        : score >= 65
          ? { label: "Performa Baik", tone: "blue" as const }
          : score >= 50
            ? { label: "Perlu Perhatian", tone: "amber" as const }
            : { label: "Perlu Tindakan Segera", tone: "red" as const };

  return { score, label, tone, components };
}

export async function getExecutiveOverview(companyId: string): Promise<ExecutiveOverview> {
  const contributions = await Promise.all(
    CONTRIBUTORS.map((c) =>
      c.contribute({ companyId }).catch((): ModuleContribution => ({
        // Satu modul gagal tidak boleh menjatuhkan command center
        module: c.module,
        moduleLabel: c.moduleLabel,
        active: false,
        health: [],
        kpis: [],
        insights: [],
        actions: [],
      }))
    )
  );

  const health = summarizeHealth(contributions);

  const kpis = contributions.flatMap((c) => c.kpis);

  const insights = contributions
    .flatMap((c) => c.insights)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const actions = contributions
    .flatMap((c) => c.actions)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  const briefing = buildExecutiveBriefing(health, insights, actions);

  return {
    health,
    kpis,
    insights,
    actions,
    briefing,
    modules: contributions.map((c) => ({
      module: c.module,
      moduleLabel: c.moduleLabel,
      active: c.active,
    })),
  };
}
