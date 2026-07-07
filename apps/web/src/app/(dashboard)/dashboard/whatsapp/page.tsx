import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { MessageCircle, ShoppingCart, PhoneMissed, AlertCircle } from "lucide-react";

export const metadata = { title: "WhatsApp AI — AODP" };

const FEATURE_CARDS = [
  {
    icon: <MessageCircle className="h-6 w-6 text-green-500" />,
    title: "Inbox & Leads",
    description: "Daftar percakapan masuk, identifikasi customer, dan kualifikasi nomor baru.",
    badge: "Segera Hadir",
    color: "green",
  },
  {
    icon: <ShoppingCart className="h-6 w-6 text-blue-500" />,
    title: "Order Intent Detection",
    description: "AI mendeteksi chat berisi order dan mengekstrak item pesanan agar tidak ada order yang hilang.",
    badge: "Segera Hadir",
    color: "blue",
  },
  {
    icon: <PhoneMissed className="h-6 w-6 text-orange-500" />,
    title: "Missed Call Follow-up",
    description: "Template follow-up otomatis untuk telepon yang tidak terjawab dan repeat order reminder.",
    badge: "Segera Hadir",
    color: "orange",
  },
  {
    icon: <AlertCircle className="h-6 w-6 text-red-500" />,
    title: "Complaint Tagging",
    description: "Deteksi dan penandaan komplain barang kurang atau rusak, plus ringkasan harian untuk owner.",
    badge: "Segera Hadir",
    color: "red",
  },
];

const BADGE_COLOR: Record<string, string> = {
  green:  "bg-green-50 text-green-700",
  blue:   "bg-blue-50 text-blue-700",
  orange: "bg-orange-50 text-orange-700",
  red:    "bg-red-50 text-red-700",
};

export default async function WhatsAppPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin");

  if (!hasAccess) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="WhatsApp AI"
        subtitle="Front office distributor — tangkap order, follow-up missed call, dan ringkasan chat harian."
      />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-medium text-amber-800">
          Modul WhatsApp AI sedang disiapkan
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          Modul ini dibangun bertahap sesuai roadmap AODP. Integrasi WhatsApp menggunakan
          abstraksi webhook yang sudah tersedia di platform.
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
