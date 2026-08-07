import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { updateCustomerAction } from "@/lib/customers/actions";
import { CustomerForm } from "@/components/customers/customer-form";
import { ChevronLeft } from "lucide-react";
import type { CustomerFormData } from "@/lib/customers/actions";

export const metadata = { title: "Edit Pelanggan — AODP" };

interface SalesUser { id: string; full_name: string; }

interface Customer {
  id: string;
  code: string;
  name: string;
  type: "reseller" | "direct" | "distributor" | "modern_trade";
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  coverage_area_id: string | null;
  assigned_sales_id: string | null;
  notes: string | null;
  is_active: boolean;
  custom_fields: Record<string, string>;
}

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "customers.update")) {
    redirect(`/dashboard/customers/${id}`);
  }

  const supabase = await createClient();

  const [customerResult, salesResult, areaResult] = await Promise.all([
    supabase
      .from("customers")
      .select("id, code, name, type, phone, email, address, city, coverage_area_id, assigned_sales_id, notes, is_active, custom_fields")
      .eq("id", id)
      .eq("company_id", user.company_id)
      .single(),

    // Membership role sebenarnya ada di user_roles/roles (bukan kolom
    // users.roles yang tidak ada) -- pola sama dengan kpi/setup/page.tsx.
    supabase
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", user.company_id),

    // Aktif + wilayah yang sedang di-assign (walau sudah nonaktif) supaya
    // histori tetap terlihat -- tidak boleh dipilih ulang bila bukan yang
    // sedang aktif dipakai (lihat disabled di CustomerForm).
    supabase
      .from("coverage_areas")
      .select("id, name, is_active")
      .eq("company_id", user.company_id)
      .order("name"),
  ]);

  if (!customerResult.data) notFound();

  const customer   = customerResult.data as unknown as Customer;
  const salesRoleRows = (salesResult.data ?? []) as unknown as {
    user: { id: string; full_name: string; is_active: boolean } | null;
    role: { name: string } | null;
  }[];
  const salesUsers: SalesUser[] = salesRoleRows
    .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
    .map((r) => ({ id: r.user!.id, full_name: r.user!.full_name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const allAreas = ((areaResult.data ?? []) as { id: string; name: string; is_active: boolean }[]).map((a) => ({
    id: a.id,
    name: a.name,
    isActive: a.is_active,
  }));
  const coverageAreas = allAreas.filter((a) => a.isActive || a.id === customer.coverage_area_id);

  const initialData: CustomerFormData = {
    name:              customer.name,
    code:              customer.code,
    type:              customer.type,
    phone:             customer.phone,
    email:             customer.email,
    address:           customer.address,
    city:              customer.city,
    coverage_area_id:  customer.coverage_area_id,
    assigned_sales_id: customer.assigned_sales_id,
    notes:             customer.notes,
    is_active:         customer.is_active,
    custom_fields:     customer.custom_fields ?? {},
  };

  const oldData: Partial<CustomerFormData> = {
    name: customer.name, code: customer.code, is_active: customer.is_active,
    coverage_area_id: customer.coverage_area_id,
  };
  const boundAction = updateCustomerAction.bind(null, id, oldData);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href={`/dashboard/customers/${id}`} className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Pelanggan
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Edit Pelanggan</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mengedit: <span className="font-medium text-gray-700">{customer.name}</span>
          <span className="ml-2 font-mono text-gray-400 text-xs">{customer.code}</span>
        </p>
      </div>

      <CustomerForm
        initialData={initialData}
        salesUsers={salesUsers}
        coverageAreas={coverageAreas}
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/customers/${id}`}
      />
    </div>
  );
}
