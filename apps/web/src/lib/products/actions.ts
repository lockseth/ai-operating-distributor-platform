"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { logAuditEvent } from "@/lib/actions/audit";

export interface ProductFormData {
  name: string;
  sku: string;
  category_id: string | null;
  unit: string;
  price: number;
  cost: number | null;
  stock_quantity: number;
  min_stock: number;
  description: string | null;
  is_active: boolean;
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createProductAction(data: ProductFormData): Promise<void> {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "products.create")) {
    throw new Error("Tidak memiliki akses untuk membuat produk");
  }

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("products")
    .insert({
      company_id: user.company_id,
      name: data.name.trim(),
      sku: data.sku.trim(),
      category_id: data.category_id || null,
      unit: data.unit.trim() || "pcs",
      price: data.price,
      cost: data.cost ?? null,
      stock_quantity: data.stock_quantity,
      min_stock: data.min_stock,
      description: data.description?.trim() || null,
      is_active: data.is_active,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Gagal membuat produk: ${error.message}`);

  await logAuditEvent({
    company_id: user.company_id,
    user_id: user.id,
    action: "product.create",
    entity_type: "product",
    entity_id: created.id,
    new_data: { name: data.name, sku: data.sku, price: data.price },
    module: "products",
  });

  revalidatePath("/dashboard/products");
  redirect(`/dashboard/products/${created.id}`);
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateProductAction(
  productId: string,
  oldData: Partial<ProductFormData>,
  data: ProductFormData
): Promise<void> {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "products.update")) {
    throw new Error("Tidak memiliki akses untuk mengedit produk");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("products")
    .update({
      name: data.name.trim(),
      sku: data.sku.trim(),
      category_id: data.category_id || null,
      unit: data.unit.trim() || "pcs",
      price: data.price,
      cost: data.cost ?? null,
      stock_quantity: data.stock_quantity,
      min_stock: data.min_stock,
      description: data.description?.trim() || null,
      is_active: data.is_active,
    })
    .eq("id", productId)
    .eq("company_id", user.company_id);  // tenant isolation

  if (error) throw new Error(`Gagal memperbarui produk: ${error.message}`);

  await logAuditEvent({
    company_id: user.company_id,
    user_id: user.id,
    action: "product.update",
    entity_type: "product",
    entity_id: productId,
    old_data: oldData as Record<string, unknown>,
    new_data: { name: data.name, sku: data.sku, price: data.price, is_active: data.is_active },
    module: "products",
  });

  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
  redirect(`/dashboard/products/${productId}`);
}

// ── Archive ─────────────────────────────────────────────────────────────────

export async function archiveProductAction(productId: string): Promise<void> {
  const user = await getAuthUser();

  if (
    !hasPermission(user.permissions, "products.delete") &&
    !hasPermission(user.permissions, "products.update")
  ) {
    throw new Error("Tidak memiliki akses untuk mengarsipkan produk");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("products")
    .update({ is_active: false })
    .eq("id", productId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(`Gagal mengarsipkan produk: ${error.message}`);

  await logAuditEvent({
    company_id: user.company_id,
    user_id: user.id,
    action: "product.archive",
    entity_type: "product",
    entity_id: productId,
    new_data: { is_active: false },
    module: "products",
  });

  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
}

// ── Activate ─────────────────────────────────────────────────────────────────

export async function activateProductAction(productId: string): Promise<void> {
  const user = await getAuthUser();

  if (!hasPermission(user.permissions, "products.update")) {
    throw new Error("Tidak memiliki akses untuk mengaktifkan produk");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("products")
    .update({ is_active: true })
    .eq("id", productId)
    .eq("company_id", user.company_id);

  if (error) throw new Error(`Gagal mengaktifkan produk: ${error.message}`);

  await logAuditEvent({
    company_id: user.company_id,
    user_id: user.id,
    action: "product.activate",
    entity_type: "product",
    entity_id: productId,
    new_data: { is_active: true },
    module: "products",
  });

  revalidatePath(`/dashboard/products/${productId}`);
  revalidatePath("/dashboard/products");
}
