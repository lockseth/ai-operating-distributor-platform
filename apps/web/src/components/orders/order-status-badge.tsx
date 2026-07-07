import type { OrderStatus } from "@/lib/orders/actions";

const STATUS_CONFIG: Record<OrderStatus, { label: string; className: string }> = {
  draft:      { label: "Draft",        className: "bg-gray-100 text-gray-600" },
  confirmed:  { label: "Dikonfirmasi", className: "bg-blue-100 text-blue-700" },
  processing: { label: "Diproses",     className: "bg-yellow-100 text-yellow-700" },
  delivering: { label: "Dikirim",      className: "bg-orange-100 text-orange-700" },
  delivered:  { label: "Terkirim",     className: "bg-green-100 text-green-700" },
  invoiced:   { label: "Ditagih",      className: "bg-purple-100 text-purple-700" },
  paid:       { label: "Lunas",        className: "bg-emerald-100 text-emerald-700" },
  cancelled:  { label: "Dibatalkan",   className: "bg-red-100 text-red-600" },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as OrderStatus] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

export { STATUS_CONFIG };
