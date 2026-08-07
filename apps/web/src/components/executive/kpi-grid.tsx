import {
  TrendingUp,
  Activity,
  Target,
  Store,
  ClipboardList,
  ShoppingCart,
  Phone,
  PhoneCall,
  ListOrdered,
  MapPin,
} from "lucide-react";
import { KpiCard } from "@/components/ui/kpi-card";
import type { ExecutiveKpi } from "@/lib/executive/types";

interface KpiGridProps {
  kpis: ExecutiveKpi[];
}

const KPI_ICONS: Record<string, React.ReactNode> = {
  revenue_today: <TrendingUp className="h-4 w-4" />,
  achieved_revenue_month: <Activity className="h-4 w-4" />,
  gap_revenue: <Target className="h-4 w-4" />,
  oa_month: <Store className="h-4 w-4" />,
  call_period: <Phone className="h-4 w-4" />,
  effective_call_period: <PhoneCall className="h-4 w-4" />,
  order_count_period: <ListOrdered className="h-4 w-4" />,
  noo_period: <MapPin className="h-4 w-4" />,
  sales_reported_today: <ClipboardList className="h-4 w-4" />,
  orders_7d: <ShoppingCart className="h-4 w-4" />,
};

export function KpiGrid({ kpis }: KpiGridProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {kpis.map((kpi) => (
        <KpiCard
          key={kpi.key}
          label={kpi.label}
          value={kpi.value}
          subValue={kpi.subValue}
          accent={kpi.accent}
          trend={kpi.trend}
          trendLabel={kpi.trendLabel}
          icon={KPI_ICONS[kpi.key]}
        />
      ))}
    </div>
  );
}
