"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getSalesKpiAchievementProjectionAction,
} from "@/lib/sales-kpi/actions";
import type {
  SalesKpiAchievementLine,
  SalesKpiAchievementProjection,
  SalesKpiPacingStatus,
} from "@/lib/sales-kpi/types";

interface PeriodOption {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface SalesmanOption {
  id: string;
  fullName: string;
}

interface KpiAchievementViewProps {
  periods: PeriodOption[];
  salesmen: SalesmanOption[];
  canManage: boolean;
  selfId: string;
  isSelfSalesperson: boolean;
}

const PACING_LABEL: Record<SalesKpiPacingStatus, string> = {
  NOT_STARTED: "Belum Mulai",
  ON_TRACK: "Sesuai Target",
  AHEAD: "Di Atas Target",
  BEHIND: "Tertinggal",
  COMPLETE: "Periode Selesai",
  DATA_INSUFFICIENT: "Data Belum Cukup",
};

const PACING_TONE: Record<SalesKpiPacingStatus, string> = {
  NOT_STARTED: "bg-gray-100 text-gray-600",
  ON_TRACK: "bg-blue-50 text-blue-700",
  AHEAD: "bg-green-50 text-green-700",
  BEHIND: "bg-amber-50 text-amber-700",
  COMPLETE: "bg-gray-100 text-gray-600",
  DATA_INSUFFICIENT: "bg-gray-100 text-gray-500",
};

function AchievementCard({ label, line }: { label: string; line: SalesKpiAchievementLine }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">{label}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PACING_TONE[line.pacingStatus]}`}>
          {PACING_LABEL[line.pacingStatus]}
        </span>
      </div>

      {line.target === null ? (
        <p className="mt-3 text-sm text-gray-400">Data belum cukup -- target belum dikonfigurasi untuk periode ini.</p>
      ) : (
        <div className="mt-3 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-gray-900">{line.actual}</span>
            <span className="text-sm text-gray-400">/ {line.target}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-blue-500"
              style={{ width: `${Math.min(100, line.achievementPercentage ?? 0)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>{line.achievementPercentage}% tercapai</span>
            <span>Sisa {line.remaining}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function KpiAchievementView({
  periods,
  salesmen,
  canManage,
  selfId,
  isSelfSalesperson,
}: KpiAchievementViewProps) {
  const defaultPeriod = useMemo(
    () => periods.find((p) => p.status === "ACTIVE")?.id ?? periods[0]?.id ?? "",
    [periods],
  );
  const [periodId, setPeriodId] = useState(defaultPeriod);
  const [salespersonId, setSalespersonId] = useState(
    isSelfSalesperson ? selfId : (salesmen[0]?.id ?? ""),
  );
  const [projection, setProjection] = useState<SalesKpiAchievementProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!periodId || !salespersonId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const result = await getSalesKpiAchievementProjectionAction(periodId, salespersonId);
      if (cancelled) return;
      setLoading(false);
      if (result.ok && result.projection) {
        setProjection(result.projection);
      } else {
        setProjection(null);
        setError(result.error ?? "Data belum cukup.");
      }
    }
    void load();

    return () => {
      cancelled = true;
    };
  }, [periodId, salespersonId]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-gray-500">Periode</span>
          <select
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.status})
              </option>
            ))}
          </select>
        </label>

        {canManage && (
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-gray-500">Salesman</span>
            <select
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
              value={salespersonId}
              onChange={(e) => setSalespersonId(e.target.value)}
            >
              <option value="">Pilih salesman</option>
              {salesmen.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400">Memuat achievement...</p>}
      {!loading && error && <p className="text-sm text-gray-400">{error}</p>}

      {!loading && projection && (
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AchievementCard label="Call" line={projection.call} />
            <AchievementCard label="Effective Call" line={projection.effectiveCall} />
          </div>
          {projection.sourceFreshness === "DATA_INSUFFICIENT" && (
            <p className="mt-3 text-xs text-gray-400">
              Data belum cukup -- belum ada target CALL maupun EFFECTIVE_CALL yang dikonfigurasi untuk salesman/periode ini.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
