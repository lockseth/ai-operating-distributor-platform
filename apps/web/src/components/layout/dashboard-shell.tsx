interface StatCardProps {
  label: string;
  value: string;
  description?: string;
  accent?: "blue" | "green" | "amber" | "red" | "purple";
}

export function StatCard({
  label,
  value,
  description,
  accent = "blue",
}: StatCardProps) {
  const accentClass: Record<string, string> = {
    blue: "text-blue-600",
    green: "text-green-600",
    amber: "text-amber-600",
    red: "text-red-600",
    purple: "text-purple-600",
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-bold ${accentClass[accent]}`}>
        {value}
      </p>
      {description && (
        <p className="mt-1 text-xs text-gray-400">{description}</p>
      )}
    </div>
  );
}

interface AlertCardProps {
  type: "info" | "warning" | "success" | "ai";
  title: string;
  message: string;
}

export function AlertCard({ type, title, message }: AlertCardProps) {
  const styles: Record<string, string> = {
    info: "bg-blue-50 border-blue-100 text-blue-900",
    warning: "bg-amber-50 border-amber-100 text-amber-900",
    success: "bg-green-50 border-green-100 text-green-900",
    ai: "bg-purple-50 border-purple-100 text-purple-900",
  };
  const icons: Record<string, string> = {
    info: "ℹ️",
    warning: "⚠️",
    success: "✅",
    ai: "🤖",
  };

  return (
    <div className={`rounded-xl border p-4 ${styles[type]}`}>
      <p className="text-sm font-semibold">
        {icons[type]} {title}
      </p>
      <p className="mt-1 text-sm opacity-80">{message}</p>
    </div>
  );
}

interface DashboardShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export function DashboardShell({
  title,
  subtitle,
  children,
}: DashboardShellProps) {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
