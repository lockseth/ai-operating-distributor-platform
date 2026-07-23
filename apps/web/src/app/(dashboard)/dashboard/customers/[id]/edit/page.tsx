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
  area: string | null;
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

  const [customerResult, salesResult] = await Promise.all([
    supabase
      .from("customers")
      .select("id, code, name, type, phone, email, address, city, area, assigned_sales_id, notes, is_active, custom_fields")
      .eq("id", id)
      .eq("company_id", user.company_id)
      .single(),

    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .contains("roles", ["sales"])
      .order("full_name"),
  ]);

  if (!customerResult.data) notFound();

  const customer   = customerResult.data as unknown as Customer;
  const salesUsers = (salesResult.data ?? []) as unknown as SalesUser[];

  const initialData: CustomerFormData = {
    name:              customer.name,
    code:              customer.code,
    type:              customer.type,
    phone:             customer.phone,
    email:             customer.email,
    address:           customer.address,
    city:              customer.city,
    area:              customer.area,
    assigned_sales_id: customer.assigned_sales_id,
    notes:             customer.notes,
    is_active:         customer.is_active,
    custom_fields:     customer.custom_fields ?? {},
  };

  const oldData: Partial<CustomerFormData> = {
    name: customer.name, code: customer.code, is_active: customer.is_active,
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
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/customers/${id}`}
      />
    </div>
  );
}
