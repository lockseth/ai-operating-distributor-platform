import type {
  ExecutiveBriefing,
  ExecutiveInsight,
  ExecutiveAction,
  HealthSummary,
} from "./types";

// =============================================================================
// Briefing Eksekutif — deterministik v1 (AI Constitution #6: tanpa AI-washing).
// Menyusun narasi pagi owner dari health score + insight + action, tanpa
// memanggil model AI. Versi AI penuh menggantikan file ini lewat AI Provider
// Layer setelah pola penggunaan tervalidasi.
// =============================================================================

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function buildExecutiveBriefing(
  health: HealthSummary,
  insights: ExecutiveInsight[],
  actions: ExecutiveAction[]
): ExecutiveBriefing {
  const paragraphs: string[] = [];

  // Headline: kondisi keseluruhan + pendorong terbesar
  const weakest = [...health.components].sort((a, b) => a.score - b.score)[0];
  const strongest = [...health.components].sort((a, b) => b.score - a.score)[0];

  const headline =
    health.components.length === 0
      ? "Belum ada data untuk menilai kondisi bisnis hari ini."
      : `Kondisi bisnis hari ini: ${health.label} (skor ${health.score}/100).`;

  if (health.components.length > 0 && weakest && strongest) {
    if (weakest.key === strongest.key) {
      paragraphs.push(strongest.reason + ".");
    } else {
      paragraphs.push(
        `Yang paling menahan skor: ${weakest.label.toLowerCase()} — ${weakest.reason}. ` +
          `Yang paling sehat: ${strongest.label.toLowerCase()} — ${strongest.reason}.`
      );
    }
  }

  // Perhatian utama: maksimal 3 insight terpenting
  const topInsights = [...insights]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, 3);
  if (topInsights.length > 0) {
    paragraphs.push(
      "Perhatian hari ini: " +
        topInsights.map((i, idx) => `(${idx + 1}) ${i.title.toLowerCase()}`).join("; ") +
        "."
    );
  }

  // Penutup: tindakan prioritas teratas
  const urgent = actions.find((a) => a.priority === "URGENT") ?? actions[0];
  if (urgent) {
    paragraphs.push(`Rekomendasi pertama: ${urgent.action.toLowerCase()} — ${urgent.rationale.toLowerCase()}.`);
  } else if (health.components.length > 0) {
    paragraphs.push("Tidak ada tindakan mendesak — pertahankan ritme saat ini.");
  }

  return { headline, paragraphs, generatedBy: "deterministic-v1" };
}
