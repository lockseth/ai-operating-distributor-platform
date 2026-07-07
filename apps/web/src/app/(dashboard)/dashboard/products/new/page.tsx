import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { createProductAction } from "@/lib/products/actions";
import { ProductForm } from "@/components/products/product-form";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Tambah Produk — AODP" };

interface Category { id: string; name: string; }

export default async function NewProductPage() {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "products.create")) {
    redirect("/dashboard/products");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("company_id", user.company_id)
    .order("name");

  const categories = (data ?? []) as unknown as Category[];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href="/dashboard/products" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Produk
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Tambah Produk Baru</h1>
        <p className="text-sm text-gray-500 mt-1">Isi form di bawah untuk menambahkan produk ke katalog</p>
      </div>

      <ProductForm
        categories={categories}
        action={createProductAction}
        submitLabel="Simpan Produk"
        cancelHref="/dashboard/products"
      />
    </div>
  );
}
