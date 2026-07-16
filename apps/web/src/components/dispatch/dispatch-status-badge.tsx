import type { PlanningStatus } from "@/lib/dispatch/types";

const STATUS_CONFIG: Record<PlanningStatus, { label: string; className: string }> = {
  document_ready:           { label: "Menunggu Perencanaan", className: "bg-gray-100 text-gray-600" },
  waiting_planning:         { label: "Sedang Direncanakan",  className: "bg-gray-100 text-gray-600" },
  planned:                  { label: "Direncanakan",         className: "bg-blue-100 text-blue-700" },
  scheduled:                { label: "Terjadwal",            className: "bg-emerald-100 text-emerald-700" },
  ready_for_delivery:       { label: "Siap Dikirim",         className: "bg-green-100 text-green-700" },
  waiting_stock:            { label: "Menunggu Stok",        className: "bg-amber-100 text-amber-700" },
  customer_requested_delay: { label: "Ditunda oleh Toko",    className: "bg-orange-100 text-orange-700" },
  manual_hold:              { label: "Ditahan Manual",       className: "bg-yellow-100 text-yellow-700" },
  route_conflict:           { label: "Konflik Muatan/Rute",  className: "bg-red-100 text-red-600" },
  cancelled:                { label: "Dibatalkan",           className: "bg-gray-100 text-gray-500" },
};

export function DispatchStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as PlanningStatus] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

export { STATUS_CONFIG };
