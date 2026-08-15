"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  ON_TRACK: "bg-blue-100 text-blue-700",
  AHEAD: "bg-green-100 text-green-700",
  BEHIND: "bg-amber-100 text-amber-700",
  COMPLETE: "bg-gray-100 text-gray-600",
  DATA_INSUFFICIENT: "bg-gray-100 text-gray-500",
};

// Warna kartu penuh (border + background tint) mengikuti pacing status --
// bukan cuma badge kecil di pojok, supaya status kelihatan sekilas.
const PACING_CARD_TONE: Record<SalesKpiPacingStatus, string> = {
  NOT_STARTED: "border-gray-200 bg-gray-50",
  ON_TRACK: "border-blue-200 bg-blue-50/60",
  AHEAD: "border-green-200 bg-green-50/60",
  BEHIND: "border-amber-200 bg-amber-50/60",
  COMPLETE: "border-gray-200 bg-gray-50",
  DATA_INSUFFICIENT: "border-gray-200 bg-gray-50",
};

const PACING_BAR_TONE: Record<SalesKpiPacingStatus, string> = {
  NOT_STARTED: "bg-gray-400",
  ON_TRACK: "bg-blue-500",
  AHEAD: "bg-green-500",
  BEHIND: "bg-amber-500",
  COMPLETE: "bg-gray-400",
  DATA_INSUFFICIENT: "bg-gray-300",
};

function formatIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}

function AchievementCard({
  label,
  line,
  format = "count",
  href,
}: {
  label: string;
  line: SalesKpiAchievementLine;
  format?: "count" | "currency";
  href?: string;
}) {
  const fmt = (n: number) => (format === "currency" ? formatIDR(n) : String(n));

  const content = (
    <>
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
            <span className="text-2xl font-bold text-gray-900">{fmt(line.actual)}</span>
            <span className="text-sm text-gray-400">/ {fmt(line.target)}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/70">
            <div
              className={`h-full rounded-full ${PACING_BAR_TONE[line.pacingStatus]}`}
              style={{ width: `${Math.min(100, line.achievementPercentage ?? 0)}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>{line.achievementPercentage}% tercapai</span>
            <span>Sisa {fmt(line.remaining ?? 0)}</span>
          </div>
        </div>
      )}
    </>
  );

  const cardClass = `rounded-xl border p-4 transition-shadow ${PACING_CARD_TONE[line.pacingStatus]}`;

  if (href) {
    return (
      <Link href={href} className={`block ${cardClass} hover:shadow-md`}>
        {content}
      </Link>
    );
  }
  return <div className={cardClass}>{content}</div>;
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

  const ordersHref = useMemo(() => {
    if (!salespersonId) return undefined;
    const period = periods.find((p) => p.id === periodId);
    const sp = new URLSearchParams({ sales: salespersonId, status: "confirmed" });
    if (period) {
      sp.set("date_from", period.startDate);
      sp.set("date_to", period.endDate);
    }
    return `/dashboard/orders?${sp.toString()}`;
  }, [salespersonId, periodId, periods]);

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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <AchievementCard
              label="Call"
              line={projection.call}
              href={isSelfSalesperson ? "/dashboard/sales-visits" : undefined}
            />
            <AchievementCard
              label="Effective Call"
              line={projection.effectiveCall}
              href={isSelfSalesperson ? "/dashboard/sales-visits" : undefined}
            />
            <AchievementCard
              label="Order Count"
              line={projection.orderCount}
              href={ordersHref}
            />
            <AchievementCard
              label="Revenue"
              line={projection.revenue}
              format="currency"
              href={ordersHref}
            />
            <AchievementCard
              label="NOO / Buka Toko Baru"
              line={projection.noo}
              href={salespersonId ? `/dashboard/customers?sales=${salespersonId}` : undefined}
            />
          </div>
          {projection.sourceFreshness === "DATA_INSUFFICIENT" && (
            <p className="mt-3 text-xs text-gray-400">
              Data belum cukup -- belum ada target CALL, EFFECTIVE_CALL, ORDER_COUNT, REVENUE, maupun NOO yang dikonfigurasi untuk salesman/periode ini.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
