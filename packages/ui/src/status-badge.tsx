import * as React from "react";
import { Badge } from "./badge";

interface StatusBadgeProps {
  status: string;
  className?: string;
}

const statusConfig: Record<string, { label: string; variant: "default" | "success" | "warning" | "danger" | "info" }> = {
  draft: { label: "Draft", variant: "default" },
  confirmed: { label: "Dikonfirmasi", variant: "info" },
  processing: { label: "Diproses", variant: "info" },
  delivering: { label: "Dikirim", variant: "warning" },
  delivered: { label: "Terkirim", variant: "success" },
  invoiced: { label: "Ditagih", variant: "warning" },
  paid: { label: "Lunas", variant: "success" },
  cancelled: { label: "Dibatalkan", variant: "danger" },
  active: { label: "Aktif", variant: "success" },
  inactive: { label: "Tidak Aktif", variant: "default" },
  suspended: { label: "Ditangguhkan", variant: "danger" },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? { label: status, variant: "default" as const };
  return (
    <Badge variant={config.variant} className={className}>
      {config.label}
    </Badge>
  );
}
