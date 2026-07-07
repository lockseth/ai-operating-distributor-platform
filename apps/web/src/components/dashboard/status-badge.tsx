const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending:    { label: "Pending",     className: "bg-gray-100 text-gray-700" },
  confirmed:  { label: "Dikonfirmasi",className: "bg-blue-100 text-blue-700" },
  delivering: { label: "Dikirim",     className: "bg-amber-100 text-amber-700" },
  delivered:  { label: "Terkirim",    className: "bg-green-100 text-green-700" },
  invoiced:   { label: "Ditagih",     className: "bg-purple-100 text-purple-700" },
  paid:       { label: "Lunas",       className: "bg-green-100 text-green-800" },
  cancelled:  { label: "Dibatalkan",  className: "bg-red-100 text-red-700" },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { label: status, className: "bg-gray-100 text-gray-700" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}
