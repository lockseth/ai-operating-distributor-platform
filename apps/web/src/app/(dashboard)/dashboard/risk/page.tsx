import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { ShieldAlert, Percent, UserX, Gauge } from "lucide-react";

export const metadata = { title: "Risk Alert — AODP" };

const FEATURE_CARDS = [
  {
    icon: <ShieldAlert className="h-6 w-6 text-red-500" />,
    title: "Risk Alert List",
    description: "Daftar alert dengan severity, kategori, entitas terkait, dan rekomendasi tindakan untuk owner.",
    badge: "Segera Hadir",
    color: "red",
  },
  {
    icon: <Percent className="h-6 w-6 text-orange-500" />,
    title: "Discount Anomaly",
    description: "Deteksi diskon di luar aturan dan kebocoran diskon yang melebar ke banyak sales.",
    badge: "Segera Hadir",
    color: "orange",
  },
  {
    icon: <UserX className="h-6 w-6 text-purple-500" />,
    title: "Behavior Change",
    description: "Alert saat perilaku customer berubah mencurigakan — PIC order berganti, pola order menurun drastis.",
    badge: "Segera Hadir",
    color: "purple",
  },
  {
    icon: <Gauge className="h-6 w-6 text-blue-500" />,
    title: "Transaction Risk Score",
    description: "Skor risiko per transaksi dan indikator risiko per sales sebagai early warning system.",
    badge: "Segera Hadir",
    color: "blue",
  },
];

const BADGE_COLOR: Record<string, string> = {
  red:    "bg-red-50 text-red-700",
  orange: "bg-orange-50 text-orange-700",
  purple: "bg-purple-50 text-purple-700",
  blue:   "bg-blue-50 text-blue-700",
};

export default async function RiskPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager");

  if (!hasAccess) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Business Guard AI"
        subtitle="Early warning system — jaga bisnis dari fraud, diskon bocor, dan transaksi berisiko."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">
          Modul Business Guard AI sedang disiapkan
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Alert risiko hanya dapat dilihat owner dan manager — tidak dapat dihapus oleh sales.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FEATURE_CARDS.map((card) => (
          <div
            key={card.title}
            className="rounded-lg border border-gray-200 bg-white p-5 opacity-75"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-50">
                  {card.icon}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{card.title}</p>
                  <p className="mt-0.5 text-xs text-gray-500">{card.description}</p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_COLOR[card.color]}`}
              >
                {card.badge}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
