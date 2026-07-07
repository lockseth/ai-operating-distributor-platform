import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createOrderAction } from "@/lib/orders/actions";
import { OrderForm } from "@/components/orders/order-form";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Buat Sales Order — AODP" };

export default async function NewOrderPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "orders.create")) {
    redirect("/dashboard/orders");
  }

  const supabase = await createClient();

  const [customersResult, productsResult, salesResult] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, code, phone, area")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("name"),

    supabase
      .from("products")
      .select("id, name, sku, unit, price")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("name"),

    supabase
      .from("users")
      .select("id, full_name")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .contains("roles", ["sales"])
      .order("full_name"),
  ]);

  const customers  = (customersResult.data ?? []) as { id: string; name: string; code: string; phone: string | null; area: string | null }[];
  const products   = (productsResult.data ?? []) as { id: string; name: string; sku: string; unit: string; price: number }[];
  const salesUsers = (salesResult.data ?? []) as { id: string; full_name: string }[];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href="/dashboard/orders" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Sales Order
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Buat Sales Order Baru</h1>
        <p className="text-sm text-gray-500 mt-1">Isi form di bawah untuk membuat order penjualan</p>
      </div>

      <OrderForm
        customers={customers}
        products={products}
        salesUsers={salesUsers}
        action={createOrderAction}
        submitLabel="Buat Order"
        cancelHref="/dashboard/orders"
      />
    </div>
  );
}
