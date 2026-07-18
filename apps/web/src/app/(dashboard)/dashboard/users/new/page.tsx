import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { AddSalesmanForm } from "@/components/users/add-salesman-form";

export const metadata = { title: "Tambah Salesman — AODP" };

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

function extractCoverageAreas(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as Record<string, unknown>).coverage_areas;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

export default async function NewSalesmanPage() {
  const user = await getAuthUser();

  const canManage =
    hasPermission(user.permissions, "users.manage") ||
    MANAGE_ROLES.some((role) => user.roles.includes(role));

  if (!canManage) redirect("/dashboard/users");

  const supabase = await createClient();
  const { data: companyRow } = await supabase
    .from("companies")
    .select("settings")
    .eq("id", user.company_id)
    .maybeSingle();
  const availableAreas = extractCoverageAreas((companyRow as { settings?: unknown } | null)?.settings);

  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-sm text-gray-500">
        <Link href="/dashboard/users" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Pengguna
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Tambah Salesman</h1>
        <p className="mt-1 text-sm text-gray-500">
          Salesman baru akan tercatat pada {user.company.name}. Hubungkan akun Telegram
          setelah Salesman dibuat.
        </p>
      </div>

      <AddSalesmanForm availableAreas={availableAreas} />
    </div>
  );
}
