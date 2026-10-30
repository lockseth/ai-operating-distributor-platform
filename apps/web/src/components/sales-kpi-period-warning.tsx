import Link from "next/link";
import type { KpiPeriodHealth } from "@/lib/sales-kpi/period-health";

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// Peringatan periode KPI. Owner: ajakan membuka periode. Sales: penjelasan
// bahwa kunjungan belum terhitung. "ok" tidak menampilkan apa pun.
export function SalesKpiPeriodWarning({ health, audience }: { health: KpiPeriodHealth | null; audience: "owner" | "sales" }) {
  if (!health || health.status === "ok") return null;

  const missing = health.status === "missing";
  const title = missing ? "Periode KPI belum dibuka" : `Periode KPI ${health.periodName} berakhir ${health.daysLeft} hari lagi`;
  const body =
    audience === "owner"
      ? missing
        ? `Kunjungan sales saat ini TIDAK terhitung sebagai Call/Effective Call. Periode terakhir berakhir ${formatDate(health.lastEndDate)}. Buka periode baru dan isi target per salesman.`
        : `Siapkan periode berikutnya sebelum ${formatDate(health.endDate)} supaya kunjungan sales tetap terhitung.`
      : missing
        ? "Kunjungan Anda saat ini belum terhitung sebagai Call. Hubungi Owner untuk membuka periode KPI."
        : "Periode KPI hampir berakhir. Hubungi Owner bila periode berikutnya belum dibuka.";

  return (
    <div role="alert" className={`rounded-xl border p-4 text-sm ${missing ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{body}</p>
      {audience === "owner" && (
        <Link href="/dashboard/kpi/setup" className="mt-2 inline-block font-semibold underline">
          Buka Setup KPI
        </Link>
      )}
    </div>
  );
}
