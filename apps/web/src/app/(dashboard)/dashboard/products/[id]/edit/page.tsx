import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { updateProductAction } from "@/lib/products/actions";
import { ProductForm } from "@/components/products/product-form";
import { ChevronLeft } from "lucide-react";
import type { ProductFormData } from "@/lib/products/actions";

export const metadata = { title: "Edit Produk — AODP" };

interface Category { id: string; name: string; }

interface Product {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  price: number;
  cost: number | null;
  stock_quantity: number;
  min_stock: number;
  is_active: boolean;
  category_id: string | null;
  product_categories: { name: string } | null;
}

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();

  if (!hasPermission(user.permissions, "products.update")) {
    redirect(`/dashboard/products/${id}`);
  }

  const supabase = await createClient();

  const [productResult, categoriesResult] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, name, description, unit, price, cost, stock_quantity, min_stock, is_active, category_id, product_categories(name)")
      .eq("id", id)
      .eq("company_id", user.company_id)
      .single(),

    supabase
      .from("product_categories")
      .select("id, name")
      .eq("company_id", user.company_id)
      .order("name"),
  ]);

  if (!productResult.data) notFound();

  const product    = productResult.data as unknown as Product;
  const categories = (categoriesResult.data ?? []) as unknown as Category[];

  const initialData: ProductFormData = {
    name:           product.name,
    sku:            product.sku,
    category_id:    product.category_id,
    unit:           product.unit,
    price:          product.price,
    cost:           product.cost,
    stock_quantity: product.stock_quantity,
    min_stock:      product.min_stock,
    description:    product.description,
    is_active:      product.is_active,
  };

  // Bind server action with productId + oldData snapshot for audit
  const oldData: Partial<ProductFormData> = {
    name: product.name, sku: product.sku, price: product.price, is_active: product.is_active,
  };
  const boundAction = updateProductAction.bind(null, id, oldData);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href={`/dashboard/products/${id}`} className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Produk
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Edit Produk</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mengedit: <span className="font-medium text-gray-700">{product.name}</span>
          <span className="ml-2 font-mono text-gray-400">{product.sku}</span>
        </p>
      </div>

      <ProductForm
        initialData={initialData}
        categories={categories}
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/products/${id}`}
      />
    </div>
  );
}
