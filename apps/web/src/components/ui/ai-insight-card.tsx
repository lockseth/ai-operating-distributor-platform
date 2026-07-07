type InsightType = "alert" | "warning" | "opportunity" | "info" | "success";

interface AiInsightCardProps {
  type: InsightType;
  title: string;
  message: string;
  metric?: string;
  action?: string;
  timestamp?: string;
}

const TYPE_STYLES: Record<InsightType, { container: string; icon: string; badge: string; badgeText: string }> = {
  alert: {
    container: "bg-red-50 border-red-200",
    icon: "⚠️",
    badge: "bg-red-100 text-red-700",
    badgeText: "Alert",
  },
  warning: {
    container: "bg-amber-50 border-amber-200",
    icon: "🔔",
    badge: "bg-amber-100 text-amber-700",
    badgeText: "Peringatan",
  },
  opportunity: {
    container: "bg-blue-50 border-blue-200",
    icon: "💡",
    badge: "bg-blue-100 text-blue-700",
    badgeText: "Peluang",
  },
  info: {
    container: "bg-gray-50 border-gray-200",
    icon: "ℹ️",
    badge: "bg-gray-100 text-gray-700",
    badgeText: "Info",
  },
  success: {
    container: "bg-green-50 border-green-200",
    icon: "✅",
    badge: "bg-green-100 text-green-700",
    badgeText: "Positif",
  },
};

export function AiInsightCard({
  type,
  title,
  message,
  metric,
  action,
  timestamp,
}: AiInsightCardProps) {
  const styles = TYPE_STYLES[type];

  return (
    <div className={`rounded-lg border p-4 ${styles.container}`}>
      <div className="flex items-start gap-3">
        <span className="text-base leading-none mt-0.5">{styles.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900">{title}</p>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles.badge}`}>
              AI
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-600 leading-relaxed">{message}</p>
          {metric && (
            <p className="mt-1.5 text-xs font-semibold text-gray-800">{metric}</p>
          )}
          {action && (
            <p className="mt-1.5 text-xs text-blue-600 font-medium">{action}</p>
          )}
          {timestamp && (
            <p className="mt-1.5 text-xs text-gray-400">{timestamp}</p>
          )}
        </div>
      </div>
    </div>
  );
}
