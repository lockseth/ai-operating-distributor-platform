import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Plus, FileSpreadsheet, Users, Package, ShoppingCart } from "lucide-react";

export const metadata = { title: "Import Template — AODP" };

const ENTITY_ICON: Record<string, React.ReactNode> = {
  customer:    <Users className="h-4 w-4 text-blue-500" />,
  product:     <Package className="h-4 w-4 text-green-500" />,
  sales_order: <ShoppingCart className="h-4 w-4 text-orange-500" />,
};
const ENTITY_LABEL: Record<string, string> = {
  customer: "Pelanggan", product: "Produk", sales_order: "Sales Order",
};

interface Template {
  id: string; name: string; entity_type: string; description: string | null;
  column_mappings: unknown[]; is_active: boolean; created_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function ImportTemplatesPage() {
  const user = await getAuthUser();

  const hasAccess = user.roles.includes("super_admin") || user.roles.includes("owner") ||
    user.roles.includes("manager") || user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) redirect("/dashboard");

  const supabase = await createClient();
  const { data } = await supabase
    .from("import_templates")
    .select("id, name, entity_type, description, column_mappings, is_active, created_at")
    .eq("company_id", user.company_id)
    .order("created_at", { ascending: false });

  const templates = (data ?? []) as unknown as Template[];

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title="Template Import Data"
        subtitle="Konfigurasi mapping kolom Excel/CSV ke field sistem"
      >
        <Link href="/dashboard/settings/import/new"
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" />
          Buat Template
        </Link>
      </PageHeader>

      {/* Info box */}
      <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700">
        <p className="font-medium mb-1">Apa itu Import Template?</p>
        <p className="text-xs text-blue-600">
          Template import mendefinisikan bagaimana kolom di file Excel/CSV kamu dipetakan ke field di sistem.
          Sekali dibuat, template bisa digunakan berulang kali untuk import data pelanggan, produk, atau sales order.
        </p>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet className="h-10 w-10 text-gray-300" />}
          title="Belum ada template import"
          description="Buat template pertama untuk mendefinisikan mapping kolom file Excel/CSV ke sistem."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Link key={t.id} href={`/dashboard/settings/import/${t.id}`}
              className="group rounded-xl border bg-white p-5 shadow-sm hover:border-blue-300 hover:shadow-md transition-all">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  {ENTITY_ICON[t.entity_type] ?? <FileSpreadsheet className="h-4 w-4 text-gray-400" />}
                  <span className="text-xs font-medium text-gray-500">{ENTITY_LABEL[t.entity_type] ?? t.entity_type}</span>
                </div>
                <span className={`text-xs rounded-full px-2 py-0.5 ${t.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                  {t.is_active ? "Aktif" : "Nonaktif"}
                </span>
              </div>
              <h3 className="font-semibold text-gray-900 group-hover:text-blue-700 mb-1">{t.name}</h3>
              {t.description && <p className="text-xs text-gray-500 mb-2 line-clamp-2">{t.description}</p>}
              <div className="flex items-center justify-between text-xs text-gray-400 mt-3 pt-3 border-t border-gray-50">
                <span>{Array.isArray(t.column_mappings) ? t.column_mappings.length : 0} kolom dimapping</span>
                <span>{formatDate(t.created_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
