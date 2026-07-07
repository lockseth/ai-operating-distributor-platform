// =============================================================================
// Executive Intelligence — Kontrak Kontribusi Modul
// Executive Intelligence adalah lapisan muara / command center (Constitution
// v1.1, L13). Setiap modul menyumbang insight melalui kontrak di file ini;
// modul yang belum dibangun cukup mendaftarkan contributor baru di service.ts.
// =============================================================================

export type ModuleKey =
  | "flowsales"
  | "customer_health"
  | "collection"
  | "business_guard"
  | "whatsapp"
  | "warehouse";

export type Severity = "info" | "warning" | "critical";
export type Priority = "URGENT" | "HIGH" | "MEDIUM";
export type Trend = "up" | "down" | "neutral";
export type Accent = "blue" | "green" | "amber" | "red" | "purple" | "indigo";

/** Komponen penyusun Business Health Score (0–100 per komponen). */
export interface HealthComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  /** Alasan satu kalimat — AI Constitution #3: setiap penilaian punya alasan. */
  reason: string;
  trend: Trend;
}

export interface ExecutiveKpi {
  key: string;
  label: string;
  value: string;
  subValue?: string;
  accent: Accent;
  trend?: Trend;
  trendLabel?: string;
}

/** Insight naratif dari modul — bahan briefing dan alert. */
export interface ExecutiveInsight {
  module: ModuleKey;
  severity: Severity;
  title: string;
  narrative: string;
}

/** Rekomendasi tindakan untuk owner — AI merekomendasikan, owner memutuskan. */
export interface ExecutiveAction {
  module: ModuleKey;
  priority: Priority;
  action: string;
  rationale: string;
  href?: string;
}

/** Paket kontribusi satu modul ke command center. */
export interface ModuleContribution {
  module: ModuleKey;
  moduleLabel: string;
  /** false = modul belum diimplementasikan; tampil sebagai "menunggu modul". */
  active: boolean;
  health: HealthComponent[];
  kpis: ExecutiveKpi[];
  insights: ExecutiveInsight[];
  actions: ExecutiveAction[];
}

export interface ExecutiveContext {
  companyId: string;
}

export interface ExecutiveContributor {
  module: ModuleKey;
  moduleLabel: string;
  contribute(ctx: ExecutiveContext): Promise<ModuleContribution>;
}

/** Briefing eksekutif — v1 deterministik (AI Constitution #6: tanpa AI-washing). */
export interface ExecutiveBriefing {
  headline: string;
  paragraphs: string[];
  generatedBy: "deterministic-v1";
}

export interface HealthSummary {
  score: number;
  label: string;
  tone: "green" | "blue" | "amber" | "red";
  components: HealthComponent[];
}

/** Hasil agregasi service layer — satu objek untuk seluruh halaman eksekutif. */
export interface ExecutiveOverview {
  health: HealthSummary;
  kpis: ExecutiveKpi[];
  insights: ExecutiveInsight[];
  actions: ExecutiveAction[];
  briefing: ExecutiveBriefing;
  modules: { module: ModuleKey; moduleLabel: string; active: boolean }[];
}
