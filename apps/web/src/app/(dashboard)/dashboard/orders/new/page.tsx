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
      .select("id, full_name, user_roles!user_id(role:roles(name))")
      .eq("company_id", user.company_id)
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const customers  = (customersResult.data ?? []) as { id: string; name: string; code: string; phone: string | null; area: string | null }[];
  const products   = (productsResult.data ?? []) as { id: string; name: string; sku: string; unit: string; price: number }[];
  // Query di atas ambil SEMUA user aktif + role-nya (bukan filter server-side
  // via .contains("roles", ...) -- kolom "roles" tidak ada di tabel users,
  // itu bug lama yang bikin dropdown ini selalu kosong senyap. Pola join +
  // filter di JS ini identik dengan users/page.tsx yang sudah terbukti benar.
  const salesUsers = ((salesResult.data ?? []) as unknown as {
    id: string; full_name: string; user_roles: Array<{ role: { name: string } | null }>;
  }[])
    .filter((u) => u.user_roles.some((ur) => ur.role?.name === "sales"))
    .map((u) => ({ id: u.id, full_name: u.full_name }));

  const PRIVILEGED_ROLES = ["owner", "manager", "admin", "super_admin"];
  const currentUser = {
    id: user.id,
    full_name: salesUsers.find((s) => s.id === user.id)?.full_name ?? user.email,
    isPrivileged: user.roles.some((r) => PRIVILEGED_ROLES.includes(r)),
  };

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
        currentUser={currentUser}
        action={createOrderAction}
        submitLabel="Buat Order"
        cancelHref="/dashboard/orders"
      />
    </div>
  );
}
