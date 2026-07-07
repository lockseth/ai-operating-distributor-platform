"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Bar,
  BarChart,
  Legend,
} from "recharts";
import type { MonthlyRevenue } from "@/lib/dashboard/owner-metrics";

function formatIDR(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}M`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}Jt`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}Rb`;
  return value.toLocaleString("id-ID");
}

function formatIDRFull(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

function RevenueTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-lg text-xs">
      <p className="font-semibold text-gray-900 mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-gray-600">{p.name}:</span>
          <span className="font-medium text-gray-900">
            {p.name === "Revenue" ? formatIDRFull(p.value) : p.value.toLocaleString("id-ID")}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RevenueTrendChartProps {
  data: MonthlyRevenue[];
}

export function RevenueTrendChart({ data }: RevenueTrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#2563EB" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#2563EB" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="ordersGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#7C3AED" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#7C3AED" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="revenue"
          tickFormatter={formatIDR}
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
          width={52}
        />
        <YAxis
          yAxisId="orders"
          orientation="right"
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        <Tooltip content={<RevenueTooltip />} />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
        />
        <Area
          yAxisId="revenue"
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke="#2563EB"
          strokeWidth={2}
          fill="url(#revenueGrad)"
          dot={{ r: 3, fill: "#2563EB", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
        <Area
          yAxisId="orders"
          type="monotone"
          dataKey="orders"
          name="Order"
          stroke="#7C3AED"
          strokeWidth={2}
          fill="url(#ordersGrad)"
          dot={{ r: 3, fill: "#7C3AED", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface AreaPerformanceChartProps {
  data: Array<{ area: string; order_count: number; revenue: number }>;
}

export function AreaPerformanceChart({ data }: AreaPerformanceChartProps) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 0, right: 20, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="area"
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
          width={100}
        />
        <Tooltip
          formatter={(v) => [(v as number).toLocaleString("id-ID"), "Order"]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar
          dataKey="order_count"
          name="Order"
          fill="#2563EB"
          radius={[0, 4, 4, 0]}
          barSize={16}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

interface ForecastChartProps {
  historicalData: MonthlyRevenue[];
  forecastValue: number;
}

export function ForecastChart({ historicalData, forecastValue }: ForecastChartProps) {
  const chartData = [
    ...historicalData.map((m) => ({ label: m.label, actual: m.revenue, forecast: null })),
    { label: "Jul*", actual: null, forecast: forecastValue },
  ];

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatIDR}
          tick={{ fontSize: 11, fill: "#6B7280" }}
          axisLine={false}
          tickLine={false}
          width={52}
        />
        <Tooltip
          formatter={(v) => [formatIDRFull(v as number), ""]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar dataKey="actual" name="Aktual" fill="#2563EB" radius={[4, 4, 0, 0]} barSize={24} />
        <Bar dataKey="forecast" name="Forecast" fill="#7C3AED" radius={[4, 4, 0, 0]} barSize={24} opacity={0.7} />
      </BarChart>
    </ResponsiveContainer>
  );
}
