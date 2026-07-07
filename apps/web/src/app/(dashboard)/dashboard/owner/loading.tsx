import { KpiCardSkeleton, ChartCardSkeleton, TableSkeleton } from "@/components/ui/loading-state";

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-gray-200 ${className}`} />;
}

export default function OwnerDashboardLoading() {
  return (
    <div className="p-6 space-y-6">

      {/* Hero Banner Skeleton */}
      <div className="rounded-2xl bg-gradient-to-br from-blue-100 to-indigo-100 p-6 animate-pulse">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-3 w-40 bg-blue-200" />
            <Skeleton className="h-7 w-48 bg-blue-200" />
            <Skeleton className="h-4 w-36 bg-blue-200" />
            <div className="flex gap-2 mt-2">
              <Skeleton className="h-6 w-32 rounded-full bg-blue-200" />
              <Skeleton className="h-6 w-28 rounded-full bg-blue-200" />
            </div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <div className="h-28 w-28 rounded-full border-8 border-blue-200 bg-transparent" />
            <Skeleton className="h-3 w-20 bg-blue-200" />
          </div>
          <div className="grid grid-cols-2 gap-2 lg:w-48">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 rounded-xl bg-blue-200" />
            ))}
          </div>
        </div>
      </div>

      {/* Health Score Breakdown Skeleton */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-7 rounded-lg" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="ml-auto h-6 w-32 rounded-full" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl bg-gray-50 border border-gray-100 p-3 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-14" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* KPI Row 1 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {[1, 2, 3].map((i) => <KpiCardSkeleton key={i} />)}
      </div>

      {/* KPI Row 2 */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {[1, 2, 3].map((i) => <KpiCardSkeleton key={i} />)}
      </div>

      {/* Alert Panel Skeleton */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-80" />
          </div>
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      </div>

      {/* AI Briefing Skeleton */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
          <Skeleton className="h-7 w-7 rounded-lg" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="ml-auto h-6 w-28 rounded-full" />
        </div>
        <div className="p-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg border border-gray-100 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-12 rounded-full ml-auto" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
      </div>

      {/* Tables Row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TableSkeleton rows={4} />
        <TableSkeleton rows={4} />
      </div>

      {/* Follow Up + Forecast */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TableSkeleton rows={3} />
        <ChartCardSkeleton />
      </div>

    </div>
  );
}
