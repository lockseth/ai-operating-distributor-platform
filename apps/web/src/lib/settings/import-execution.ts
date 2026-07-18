"use server";

import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";
import type { EntityType, ColumnMapping } from "./import-actions";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionRow {
  rowIndex: number;
  fields:   Record<string, string>;  // targetField -> transformedValue
  isValid:  boolean;
  errors:   string[];
}

export interface ImportRowError {
  row:   number;
  error: string;
}

export interface ExecutionResult {
  jobId:        string;
  totalRows:    number;
  importedRows: number;
  skippedRows:  number;
  errorRows:    number;
  errors:       ImportRowError[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeImportAction(input: {
  templateId:  string;
  fileName:    string;
  entityType:  EntityType;
  rows:        ExecutionRow[];
}): Promise<ExecutionResult> {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("manager") ||
    user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) throw new Error("Akses ditolak");

  // Modul lama ini digantikan oleh Universal Data Onboarding (/dashboard/imports)
  // untuk domain customer/product/sales_order -- tidak boleh lagi membuat batch
  // import baru lewat engine lama untuk domain yang sudah ditangani modul baru.
  // Data/riwayat lama TETAP bisa dilihat (halaman list/jobs tidak diubah/dihapus).
  void input;
  throw new Error(
    "Import lewat modul ini sudah tidak tersedia untuk data baru. Gunakan Import Data (/dashboard/imports) yang mendukung staging, validasi, reconciliation, dan rollback."
  );
}

// ---------------------------------------------------------------------------
// Customer import
// ---------------------------------------------------------------------------

async function importCustomers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  userId: string,
  rows: ExecutionRow[],
  rowErrors: ImportRowError[]
): Promise<{ imported: number; skipped: number }> {
  // Fetch all existing codes + phones for duplicate check
  const { data: existing } = await supabase
    .from("customers")
    .select("code, phone")
    .eq("company_id", companyId);

  const existingCodes  = new Set((existing ?? []).map((r) => r.code?.toLowerCase() ?? ""));
  const existingPhones = new Set(
    (existing ?? []).filter((r) => r.phone).map((r) => r.phone!.replace(/\s/g, ""))
  );

  let imported = 0;
  let skipped  = 0;

  for (const row of rows) {
    const f = row.fields;

    const code  = f.code?.trim()  ?? "";
    const phone = f.phone?.trim() ?? "";
    const name  = f.name?.trim()  ?? "";

    if (!name) {
      rowErrors.push({ row: row.rowIndex, error: "Field name kosong" });
      continue;
    }

    // Duplicate check
    if (code && existingCodes.has(code.toLowerCase())) {
      skipped++;
      rowErrors.push({ row: row.rowIndex, error: `Kode "${code}" sudah ada, baris dilewati` });
      continue;
    }
    if (!code && phone && existingPhones.has(phone.replace(/\s/g, ""))) {
      skipped++;
      rowErrors.push({ row: row.rowIndex, error: `Telepon "${phone}" sudah ada, baris dilewati` });
      continue;
    }

    const { error } = await supabase.from("customers").insert({
      company_id: companyId,
      name,
      code:       code || `IMP-${Date.now()}-${row.rowIndex}`,
      type:       (f.type?.trim() || "reseller") as string,
      phone:      phone || null,
      email:      f.email?.trim()   || null,
      address:    f.address?.trim() || null,
      city:       f.city?.trim()    || null,
      area:       f.area?.trim()    || null,
      notes:      f.notes?.trim()   || null,
      is_active:  true,
      created_by: userId,
    });

    if (error) {
      rowErrors.push({ row: row.rowIndex, error: error.message });
    } else {
      imported++;
      if (code) existingCodes.add(code.toLowerCase());
      if (phone) existingPhones.add(phone.replace(/\s/g, ""));
    }
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Product import
// ---------------------------------------------------------------------------

async function importProducts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  userId: string,
  rows: ExecutionRow[],
  rowErrors: ImportRowError[]
): Promise<{ imported: number; skipped: number }> {
  // Fetch existing SKUs
  const { data: existing } = await supabase
    .from("products")
    .select("sku")
    .eq("company_id", companyId);

  const existingSkus = new Set((existing ?? []).map((r) => r.sku?.toLowerCase() ?? ""));

  // Fetch/cache category names
  const { data: categories } = await supabase
    .from("product_categories")
    .select("id, name")
    .eq("company_id", companyId);

  const categoryMap = new Map<string, string>(
    (categories ?? []).map((c) => [c.name.toLowerCase(), c.id])
  );

  let imported = 0;
  let skipped  = 0;

  for (const row of rows) {
    const f = row.fields;

    const sku  = f.sku?.trim()  ?? "";
    const name = f.name?.trim() ?? "";

    if (!name || !sku) {
      rowErrors.push({ row: row.rowIndex, error: "Field name atau sku kosong" });
      continue;
    }

    // Duplicate check
    if (existingSkus.has(sku.toLowerCase())) {
      skipped++;
      rowErrors.push({ row: row.rowIndex, error: `SKU "${sku}" sudah ada, baris dilewati` });
      continue;
    }

    const price         = parseFloatSafe(f.price);
    const cost          = f.cost ? parseFloatSafe(f.cost) : null;
    const stockQuantity = parseIntSafe(f.stock_quantity);
    const minStock      = parseIntSafe(f.min_stock);

    // Resolve category
    let categoryId: string | null = null;
    if (f.category_name?.trim()) {
      const catKey = f.category_name.trim().toLowerCase();
      if (categoryMap.has(catKey)) {
        categoryId = categoryMap.get(catKey)!;
      } else {
        // Create category on-the-fly
        const { data: newCat } = await supabase
          .from("product_categories")
          .insert({ company_id: companyId, name: f.category_name.trim() })
          .select("id")
          .single();
        if (newCat) {
          categoryId = newCat.id;
          categoryMap.set(catKey, newCat.id);
        }
      }
    }

    const { error } = await supabase.from("products").insert({
      company_id:     companyId,
      sku,
      name,
      unit:           f.unit?.trim() || "pcs",
      price:          isNaN(price) ? 0 : price,
      cost:           cost !== null && !isNaN(cost) ? cost : null,
      stock_quantity: isNaN(stockQuantity) ? 0 : stockQuantity,
      min_stock:      isNaN(minStock) ? 0 : minStock,
      description:    f.description?.trim() || null,
      category_id:    categoryId,
      is_active:      true,
      created_by:     userId,
    });

    if (error) {
      rowErrors.push({ row: row.rowIndex, error: error.message });
    } else {
      imported++;
      existingSkus.add(sku.toLowerCase());
    }
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Sales Order import
// ---------------------------------------------------------------------------

async function importSalesOrders(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  userId: string,
  rows: ExecutionRow[],
  rowErrors: ImportRowError[]
): Promise<{ imported: number; skipped: number }> {
  // Fetch existing order numbers
  const { data: existingOrders } = await supabase
    .from("sales_orders")
    .select("order_number")
    .eq("company_id", companyId);

  const existingOrderNums = new Set(
    (existingOrders ?? []).map((o) => o.order_number?.toLowerCase() ?? "")
  );

  // Batch-fetch customers by code
  const allCustomerCodes = [...new Set(rows.map((r) => r.fields.customer_code).filter(Boolean))];
  const { data: customers } = await supabase
    .from("customers")
    .select("id, code")
    .eq("company_id", companyId)
    .in("code", allCustomerCodes);

  const customerMap = new Map<string, string>(
    (customers ?? []).map((c) => [c.code.toLowerCase(), c.id])
  );

  // Batch-fetch products by sku
  const allProductSkus = [...new Set(rows.map((r) => r.fields.product_sku).filter(Boolean))];
  const { data: products } = await supabase
    .from("products")
    .select("id, sku, price, unit")
    .eq("company_id", companyId)
    .in("sku", allProductSkus);

  const productMap = new Map<string, { id: string; price: number; unit: string }>(
    (products ?? []).map((p) => [p.sku.toLowerCase(), { id: p.id, price: p.price, unit: p.unit }])
  );

  // BUG-005: Roles are in user_roles join table — not a column on users.
  // Step 1: resolve "sales" role ID; Step 2: get user_ids; Step 3: fetch users.
  const { data: salesRoleRow } = await supabase
    .from("roles")
    .select("id")
    .eq("name", "sales")
    .is("company_id", null)   // system roles have null company_id
    .maybeSingle();

  let salesUsers: Array<{ id: string; email: string | null }> = [];
  if (salesRoleRow?.id) {
    const { data: userRoleRows } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("company_id", companyId)
      .eq("role_id", salesRoleRow.id);

    const salesIds = (userRoleRows ?? []).map((r) => r.user_id);
    if (salesIds.length > 0) {
      const { data: fetchedUsers } = await supabase
        .from("users")
        .select("id, email")
        .eq("company_id", companyId)
        .in("id", salesIds);
      salesUsers = fetchedUsers ?? [];
    }
  }

  const salesMap = new Map<string, string>(
    (salesUsers ?? []).map((u) => [u.email?.toLowerCase() ?? "", u.id])
  );

  // Group rows by order_number
  const orderGroups = new Map<string, ExecutionRow[]>();
  for (const row of rows) {
    const num = row.fields.order_number?.trim() ?? "";
    if (!num) {
      rowErrors.push({ row: row.rowIndex, error: "order_number kosong" });
      continue;
    }
    if (!orderGroups.has(num)) orderGroups.set(num, []);
    orderGroups.get(num)!.push(row);
  }

  let imported = 0;
  let skipped  = 0;

  for (const [orderNumber, orderRows] of orderGroups.entries()) {
    const firstRow = orderRows[0];
    const f        = firstRow.fields;

    // Duplicate check
    if (existingOrderNums.has(orderNumber.toLowerCase())) {
      skipped++;
      orderRows.forEach((r) =>
        rowErrors.push({ row: r.rowIndex, error: `Order "${orderNumber}" sudah ada, dilewati` })
      );
      continue;
    }

    // Lookup customer
    const customerCode = f.customer_code?.trim() ?? "";
    const customerId   = customerMap.get(customerCode.toLowerCase());
    if (!customerId) {
      orderRows.forEach((r) =>
        rowErrors.push({
          row:   r.rowIndex,
          error: `Kode pelanggan "${customerCode}" tidak ditemukan`,
        })
      );
      continue;
    }

    // Build items
    const items: Array<{
      product_id:      string;
      quantity:        number;
      unit_price:      number;
      discount_amount: number;
      total_amount:    number;
      notes:           string | null;
    }> = [];

    let hasItemError = false;
    for (const row of orderRows) {
      const rf   = row.fields;
      const sku  = rf.product_sku?.trim() ?? "";
      const prod = productMap.get(sku.toLowerCase());
      if (!prod) {
        rowErrors.push({ row: row.rowIndex, error: `SKU produk "${sku}" tidak ditemukan` });
        hasItemError = true;
        continue;
      }

      const qty      = parseIntSafe(rf.quantity);
      const unitPrice = rf.unit_price ? parseFloatSafe(rf.unit_price) : prod.price;
      const discount  = rf.discount_amount ? parseFloatSafe(rf.discount_amount) : 0;
      const total     = qty * unitPrice - (isNaN(discount) ? 0 : discount);

      if (isNaN(qty) || qty <= 0) {
        rowErrors.push({ row: row.rowIndex, error: `Quantity tidak valid untuk SKU "${sku}"` });
        hasItemError = true;
        continue;
      }

      items.push({
        product_id:      prod.id,
        quantity:        qty,
        unit_price:      isNaN(unitPrice) ? prod.price : unitPrice,
        discount_amount: isNaN(discount) ? 0 : discount,
        total_amount:    total,
        notes:           rf.notes?.trim() || null,
      });
    }

    if (items.length === 0 || hasItemError) continue;

    // Compute order totals
    const subtotal   = items.reduce((s, i) => s + i.total_amount, 0);
    const orderDisc  = parseFloatSafe(f.discount_amount ?? "0");
    const tax        = (subtotal - (isNaN(orderDisc) ? 0 : orderDisc)) * 0.11;
    const finalAmt   = subtotal - (isNaN(orderDisc) ? 0 : orderDisc) + tax;

    // Resolve optional sales_id
    const salesCode = f.sales_code?.trim();
    const salesId   = salesCode ? (salesMap.get(salesCode.toLowerCase()) ?? null) : null;

    // Insert order
    const { data: newOrder, error: orderError } = await supabase
      .from("sales_orders")
      .insert({
        company_id:      companyId,
        order_number:    orderNumber,
        customer_id:     customerId,
        sales_id:        salesId,
        status:          "draft",
        total_amount:    subtotal,
        discount_amount: isNaN(orderDisc) ? 0 : orderDisc,
        tax_amount:      tax,
        final_amount:    finalAmt,
        delivery_date:   f.delivery_date || null,
        notes:           f.notes?.trim() || null,
        order_date:      new Date().toISOString(),
        created_by:      userId,
      })
      .select("id")
      .single();

    if (orderError || !newOrder) {
      orderRows.forEach((r) =>
        rowErrors.push({ row: r.rowIndex, error: orderError?.message ?? "Gagal insert order" })
      );
      continue;
    }

    // Insert items
    const { error: itemsError } = await supabase
      .from("sales_order_items")
      .insert(
        items.map((item) => ({
          order_id:        newOrder.id,
          company_id:      companyId,
          product_id:      item.product_id,
          quantity:        item.quantity,
          unit_price:      item.unit_price,
          discount_amount: item.discount_amount,
          total_amount:    item.total_amount,
          notes:           item.notes,
        }))
      );

    if (itemsError) {
      // Rollback order
      await supabase.from("sales_orders").delete().eq("id", newOrder.id);
      orderRows.forEach((r) =>
        rowErrors.push({ row: r.rowIndex, error: itemsError.message })
      );
    } else {
      imported++;
      existingOrderNums.add(orderNumber.toLowerCase());
    }
  }

  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Import job history
// ---------------------------------------------------------------------------

export async function getImportJobsAction(): Promise<{
  data?: Array<{
    id: string; entity_type: string; file_name: string; status: string;
    total_rows: number; success_rows: number; skipped_rows: number;
    error_rows: number; created_at: string;
    template: { name: string } | null;
  }>;
  error?: string;
}> {
  const user = await getAuthUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("import_jobs")
    .select("id, entity_type, file_name, status, total_rows, success_rows, skipped_rows, error_rows, created_at, template:import_templates!template_id(name)")
    .eq("company_id", user.company_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return { error: error.message };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { data: data as unknown as any[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// R-06: Re-validate each row against template column_mappings server-side.
// This prevents a malicious client from setting isValid=true on invalid rows.
function serverValidateRows(rows: ExecutionRow[], mappings: ColumnMapping[]): ExecutionRow[] {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return rows.map((row) => {
    const newErrors: string[] = [...row.errors];

    for (const m of mappings) {
      const value = (row.fields[m.target_field] ?? "").trim();

      // Required field check
      if (m.is_required && !value) {
        newErrors.push(`Field "${m.target_field}" wajib diisi`);
        continue;
      }

      if (!value) continue; // optional + empty → skip type checks

      // Type-specific validation
      switch (m.transform) {
        case "number": {
          const n = parseFloat(value.replace(/\./g, "").replace(",", "."));
          if (isNaN(n)) newErrors.push(`Field "${m.target_field}" harus berupa angka`);
          break;
        }
        case "date_iso": {
          if (isNaN(Date.parse(value)))
            newErrors.push(`Field "${m.target_field}" harus berupa tanggal valid`);
          break;
        }
        default:
          // For email fields by convention (target_field === "email")
          if (m.target_field === "email" && !EMAIL_RE.test(value)) {
            newErrors.push(`Field "email" format tidak valid`);
          }
      }
    }

    const isValid = newErrors.length === 0;
    return { ...row, isValid, errors: newErrors };
  });
}

function parseFloatSafe(v: string): number {
  return parseFloat(v.replace(/\./g, "").replace(",", "."));
}

function parseIntSafe(v: string): number {
  return parseInt(v.replace(/\D/g, ""), 10);
}
