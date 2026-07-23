import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createCustomerAction } from "@/lib/customers/actions";
import { CustomerForm } from "@/components/customers/customer-form";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Tambah Pelanggan — AODP" };

interface SalesUser { id: string; full_name: string; }

export default async function NewCustomerPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "customers.create")) {
    redirect("/dashboard/customers");
  }

  const supabase = await createClient();
  const [{ data }, { data: areaRows }] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .contains("roles", ["sales"])
      .order("full_name"),
    supabase
      .from("coverage_areas")
      .select("id, name, is_active")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("name"),
  ]);

  const salesUsers = (data ?? []) as unknown as SalesUser[];
  const coverageAreas = ((areaRows ?? []) as { id: string; name: string; is_active: boolean }[]).map((a) => ({
    id: a.id,
    name: a.name,
    isActive: a.is_active,
  }));

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href="/dashboard/customers" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Pelanggan
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Tambah Pelanggan Baru</h1>
        <p className="text-sm text-gray-500 mt-1">Isi form di bawah untuk mendaftarkan reseller atau pelanggan baru</p>
      </div>

      <CustomerForm
        salesUsers={salesUsers}
        coverageAreas={coverageAreas}
        action={createCustomerAction}
        submitLabel="Simpan Pelanggan"
        cancelHref="/dashboard/customers"
      />
    </div>
  );
}
