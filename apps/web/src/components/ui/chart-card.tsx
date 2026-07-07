interface ChartCardProps {
  title: string;
  description?: string;
  badge?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}

export function ChartCard({
  title,
  description,
  badge,
  children,
  className = "",
  action,
}: ChartCardProps) {
  return (
    <div className={`rounded-xl border border-gray-200 bg-white ${className}`}>
      <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-gray-100">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
            {badge && (
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-xs text-gray-500">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
