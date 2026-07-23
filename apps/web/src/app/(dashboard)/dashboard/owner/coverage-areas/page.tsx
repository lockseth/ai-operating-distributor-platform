import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { MapPin } from "lucide-react";
import { CoverageAreaList } from "@/components/coverage-areas/coverage-area-list";

export const metadata = { title: "Wilayah Penjualan — AODP" };

export default async function CoverageAreasPage() {
  const user = await getAuthUser();

  // Layer 1 (UI/route): hanya Owner tenant yang boleh membuka halaman ini.
  if (user.isDemo || !user.roles.includes("owner")) {
    redirect("/dashboard/users");
  }

  const supabase = await createClient();

  const [{ data: areaRows }, { data: salesmanRows }, { data: customerRows }] = await Promise.all([
    supabase
      .from("coverage_areas")
      .select("id, name, description, is_active, created_at")
      .eq("company_id", user.company_id)
      .order("name"),
    supabase
      .from("salesman_coverage_areas")
      .select("coverage_area_id, user_id")
      .eq("company_id", user.company_id),
    supabase
      .from("customers")
      .select("coverage_area_id")
      .eq("company_id", user.company_id)
      .not("coverage_area_id", "is", null),
  ]);

  const salesmanCountByArea = new Map<string, Set<string>>();
  for (const row of (salesmanRows ?? []) as { coverage_area_id: string | null; user_id: string }[]) {
    if (!row.coverage_area_id) continue;
    const set = salesmanCountByArea.get(row.coverage_area_id) ?? new Set<string>();
    set.add(row.user_id);
    salesmanCountByArea.set(row.coverage_area_id, set);
  }

  const customerCountByArea = new Map<string, number>();
  for (const row of (customerRows ?? []) as { coverage_area_id: string | null }[]) {
    if (!row.coverage_area_id) continue;
    customerCountByArea.set(row.coverage_area_id, (customerCountByArea.get(row.coverage_area_id) ?? 0) + 1);
  }

  const areas = ((areaRows ?? []) as {
    id: string;
    name: string;
    description: string | null;
    is_active: boolean;
    created_at: string;
  }[]).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    isActive: a.is_active,
    salesmanCount: salesmanCountByArea.get(a.id)?.size ?? 0,
    storeCount: customerCountByArea.get(a.id) ?? 0,
  }));

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Wilayah Penjualan"
        subtitle="Master resmi wilayah kerja tenant — dipakai bersama oleh Toko dan Salesman"
      />

      <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <p className="text-sm text-blue-800">
          Ini satu-satunya sumber wilayah resmi tenant. Toko dan Salesman merujuk ke wilayah
          yang sama persis dari sini — mengganti nama di sini otomatis tercermin di kedua
          tempat. Wilayah yang sudah dipakai tidak bisa dihapus, hanya bisa dinonaktifkan.
        </p>
      </div>

      <CoverageAreaList areas={areas} />
    </div>
  );
}
