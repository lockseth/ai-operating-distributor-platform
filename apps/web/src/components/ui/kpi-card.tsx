import { TrendingUp, TrendingDown, Minus } from "lucide-react";

type Trend = "up" | "down" | "neutral";
type Accent = "blue" | "green" | "amber" | "red" | "purple" | "indigo";

interface KpiCardProps {
  label: string;
  value: string;
  subValue?: string;
  trend?: Trend;
  trendLabel?: string;
  accent?: Accent;
  icon?: React.ReactNode;
}

const ACCENT_STYLES: Record<Accent, { badge: string; text: string; iconBg: string }> = {
  blue:   { badge: "bg-blue-50",   text: "text-blue-700",   iconBg: "bg-blue-100 text-blue-600" },
  green:  { badge: "bg-green-50",  text: "text-green-700",  iconBg: "bg-green-100 text-green-600" },
  amber:  { badge: "bg-amber-50",  text: "text-amber-700",  iconBg: "bg-amber-100 text-amber-600" },
  red:    { badge: "bg-red-50",    text: "text-red-700",    iconBg: "bg-red-100 text-red-600" },
  purple: { badge: "bg-purple-50", text: "text-purple-700", iconBg: "bg-purple-100 text-purple-600" },
  indigo: { badge: "bg-indigo-50", text: "text-indigo-700", iconBg: "bg-indigo-100 text-indigo-600" },
};

const TREND_ICON = {
  up: <TrendingUp className="h-3.5 w-3.5" />,
  down: <TrendingDown className="h-3.5 w-3.5" />,
  neutral: <Minus className="h-3.5 w-3.5" />,
};

const TREND_COLOR = {
  up: "text-green-600",
  down: "text-red-600",
  neutral: "text-gray-500",
};

export function KpiCard({
  label,
  value,
  subValue,
  trend,
  trendLabel,
  accent = "blue",
  icon,
}: KpiCardProps) {
  const styles = ACCENT_STYLES[accent];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {label}
        </p>
        {icon && (
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${styles.iconBg}`}>
            {icon}
          </div>
        )}
      </div>

      <p className={`mt-3 text-2xl font-bold ${styles.text}`}>{value}</p>

      {subValue && (
        <p className="mt-1 text-xs text-gray-500">{subValue}</p>
      )}

      {trend && trendLabel && (
        <div className={`mt-2 flex items-center gap-1 text-xs font-medium ${TREND_COLOR[trend]}`}>
          {TREND_ICON[trend]}
          <span>{trendLabel}</span>
        </div>
      )}
    </div>
  );
}
