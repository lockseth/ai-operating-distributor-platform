import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { updateOrderAction } from "@/lib/orders/actions";
import { OrderForm } from "@/components/orders/order-form";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Edit Sales Order — AODP" };

interface ExistingItem {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  discount_amount: number;
  total_amount: number;
  notes: string;
}

export default async function EditOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "orders.edit")) {
    redirect(`/dashboard/orders/${id}`);
  }

  const supabase = await createClient();

  const [orderResult, customersResult, productsResult, salesResult] = await Promise.all([
    supabase
      .from("sales_orders")
      .select(`
        id, order_number, status, customer_id, sales_id,
        discount_amount, final_amount, notes, delivery_date,
        items:sales_order_items(
          product_id, quantity, unit_price, discount_amount, total_amount, notes,
          product:products!product_id(name, sku, unit)
        )
      `)
      .eq("id", id)
      .eq("company_id", user.company_id)
      .single(),

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

  if (!orderResult.data) notFound();

  const order = orderResult.data as unknown as {
    id: string;
    order_number: string;
    status: string;
    customer_id: string;
    sales_id: string | null;
    discount_amount: number;
    final_amount: number;
    notes: string | null;
    delivery_date: string | null;
    items: Array<{
      product_id: string;
      quantity: number;
      unit_price: number;
      discount_amount: number;
      total_amount: number;
      notes: string | null;
      product: { name: string; sku: string; unit: string } | null;
    }>;
  };

  if (!["draft", "confirmed"].includes(order.status)) {
    redirect(`/dashboard/orders/${id}`);
  }

  const customers  = (customersResult.data ?? []) as { id: string; name: string; code: string; phone: string | null; area: string | null }[];
  const products   = (productsResult.data ?? []) as { id: string; name: string; sku: string; unit: string; price: number }[];
  const salesUsers = (salesResult.data ?? []) as { id: string; full_name: string }[];

  const existingItems: ExistingItem[] = order.items.map((item) => ({
    product_id:      item.product_id,
    product_name:    item.product?.name ?? "",
    unit:            item.product?.unit ?? "",
    unit_price:      item.unit_price,
    quantity:        item.quantity,
    discount_amount: item.discount_amount,
    total_amount:    item.total_amount,
    notes:           item.notes ?? "",
  }));

  const boundAction = updateOrderAction.bind(null, id, {
    order_number: order.order_number,
    final_amount: order.final_amount,
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href={`/dashboard/orders/${id}`} className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Order
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Edit Sales Order</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mengedit: <span className="font-mono font-medium text-gray-700">{order.order_number}</span>
        </p>
      </div>

      <OrderForm
        customers={customers}
        products={products}
        salesUsers={salesUsers}
        initialData={{
          customer_id:     order.customer_id,
          sales_id:        order.sales_id,
          delivery_date:   order.delivery_date ?? "",
          notes:           order.notes ?? "",
          discount_amount: order.discount_amount,
          items:           existingItems,
        }}
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/orders/${id}`}
      />
    </div>
  );
}
