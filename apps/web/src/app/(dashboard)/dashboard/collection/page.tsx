import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { CreditCard, CalendarClock, Activity, ListChecks } from "lucide-react";

export const metadata = { title: "Collection — AODP" };

const FEATURE_CARDS = [
  {
    icon: <CreditCard className="h-6 w-6 text-blue-500" />,
    title: "Piutang & Aging AR",
    description: "Daftar customer kredit aktif, jatuh tempo invoice, dan aging bucket piutang.",
    badge: "Segera Hadir",
    color: "blue",
  },
  {
    icon: <Activity className="h-6 w-6 text-orange-500" />,
    title: "Payment Behavior",
    description: "Deteksi perubahan perilaku pembayaran — customer lancar yang mulai telat bayar.",
    badge: "Segera Hadir",
    color: "orange",
  },
  {
    icon: <CalendarClock className="h-6 w-6 text-purple-500" />,
    title: "Promise to Pay",
    description: "Catat janji bayar customer dan pantau janji yang ditepati atau dilanggar.",
    badge: "Segera Hadir",
    color: "purple",
  },
  {
    icon: <ListChecks className="h-6 w-6 text-green-500" />,
    title: "Prioritas Penagihan",
    description: "Daftar prioritas collection harian dengan label risiko: Aman, Perhatian, Risiko Tinggi.",
    badge: "Segera Hadir",
    color: "green",
  },
];

const BADGE_COLOR: Record<string, string> = {
  blue:   "bg-blue-50 text-blue-700",
  orange: "bg-orange-50 text-orange-700",
  purple: "bg-purple-50 text-purple-700",
  green:  "bg-green-50 text-green-700",
};

export default async function CollectionPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.roles.includes("finance");

  if (!hasAccess) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Collection Intelligence"
        subtitle="Kendalikan piutang, aging AR, dan deteksi dini customer yang mulai macet."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">
          Modul Collection Intelligence sedang disiapkan
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Data invoice dan pembayaran dapat diimport lewat menu Import Data begitu modul ini aktif.
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
