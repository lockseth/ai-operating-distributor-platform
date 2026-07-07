import { Activity, TrendingUp, TrendingDown, Minus, CircleDashed, CircleCheck } from "lucide-react";
import type { HealthSummary, ModuleKey } from "@/lib/executive/types";

interface BusinessHealthCardProps {
  health: HealthSummary;
  modules: { module: ModuleKey; moduleLabel: string; active: boolean }[];
}

const TONE_BADGE = {
  green: "bg-green-100 text-green-800",
  blue: "bg-blue-100 text-blue-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
} as const;

const TREND_ICON = {
  up: <TrendingUp className="h-3.5 w-3.5 text-green-600" />,
  down: <TrendingDown className="h-3.5 w-3.5 text-red-600" />,
  neutral: <Minus className="h-3.5 w-3.5 text-gray-400" />,
} as const;

function barColor(score: number) {
  if (score >= 80) return "bg-green-500";
  if (score >= 65) return "bg-blue-500";
  if (score >= 50) return "bg-amber-500";
  return "bg-red-500";
}

export function BusinessHealthCard({ health, modules }: BusinessHealthCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
          <Activity className="h-4 w-4 text-blue-600" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">Business Health — Breakdown</h2>
        <span
          className={`ml-auto inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_BADGE[health.tone]}`}
        >
          {health.score}/100 · {health.label}
        </span>
      </div>

      {health.components.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400">
          Belum ada data untuk menghitung health score.
        </p>
      ) : (
        <div className="space-y-3">
          {health.components.map((c) => (
            <div key={c.key}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-800">{c.label}</span>
                  {TREND_ICON[c.trend]}
                </div>
                <span className="text-sm font-semibold text-gray-900">{c.score}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-gray-100">
                <div
                  className={`h-1.5 rounded-full ${barColor(c.score)}`}
                  style={{ width: `${Math.min(100, Math.max(0, c.score))}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">{c.reason}</p>
            </div>
          ))}
        </div>
      )}

      {/* Status modul — command center siap menerima insight modul berikutnya */}
      <div className="mt-4 border-t border-gray-100 pt-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
          Sumber Insight
        </p>
        <div className="flex flex-wrap gap-1.5">
          {modules.map((m) => (
            <span
              key={m.module}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                m.active
                  ? "bg-green-50 text-green-700 border border-green-100"
                  : "bg-gray-50 text-gray-400 border border-gray-100"
              }`}
            >
              {m.active ? (
                <CircleCheck className="h-3 w-3" />
              ) : (
                <CircleDashed className="h-3 w-3" />
              )}
              {m.moduleLabel}
              {!m.active && <span className="font-normal">· menunggu modul</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
