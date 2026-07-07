/**
 * scripts/seed-dev.ts
 *
 * Seed development/E2E untuk AODP: company pertama, user owner + sales,
 * beberapa produk master, satu customer, dan satu sales_order (untuk
 * menguji hybrid comparison di modul Sales Report). Idempotent.
 *
 * Urutan eksekusi:
 *   1. supabase db push   (apply migrations)
 *   2. pnpm seed:dev
 *
 * Env vars (dari apps/web/.env.local atau environment):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SEED_PASSWORD (opsional, default di bawah — ganti di production)
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

function loadEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), "apps", "web", ".env.local"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`[env] Loaded from ${filePath}`);
    break;
  }
}

loadEnv();

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEED_PASSWORD    = process.env.SEED_PASSWORD ?? "Aodp2026!";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY harus di-set.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPANY = {
  name: "AODP Dev Distributor",
  slug: "aodp-dev",
};

const USERS = [
  { email: "owner@aodp.test", fullName: "Owner AODP",   phone: "0812-0000-0001", role: "owner" },
  { email: "sales@aodp.test", fullName: "Sales Pertama", phone: "0812-0000-0002", role: "sales" },
] as const;

const PRODUCTS = [
  { sku: "AODP-001", name: "Air Mineral Cup 220 ml",  unit: "dus", price: 18000 },
  { sku: "AODP-002", name: "Air Mineral Botol 600 ml", unit: "dus", price: 34000 },
  { sku: "AODP-003", name: "Air Mineral Galon 19 L",   unit: "pcs", price: 21000 },
];

const CUSTOMER = {
  code: "CUST-001",
  name: "Toko Sumber Rejeki",
  type: "reseller",
  phone: "0812-9999-0001",
  area: "Cirebon Kota",
};

async function findAuthUserByEmail(email: string): Promise<string | null> {
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers gagal: ${error.message}`);
    if (!data?.users?.length) break;
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < perPage) break;
    page++;
  }
  return null;
}

async function main() {
  // 1. Company
  const { data: existingCompany } = await supabase
    .from("companies").select("id").eq("slug", COMPANY.slug).maybeSingle();

  let companyId = existingCompany?.id as string | undefined;
  if (!companyId) {
    const { data, error } = await supabase
      .from("companies")
      .insert({ name: COMPANY.name, slug: COMPANY.slug })
      .select("id")
      .single();
    if (error) throw new Error(`Gagal membuat company: ${error.message}`);
    companyId = data.id;
    console.log(`[1] Company dibuat: ${COMPANY.name} (${companyId})`);
  } else {
    console.log(`[1] Company sudah ada: ${COMPANY.name} (${companyId})`);
  }

  // 2. Users + roles
  const userIds: Record<string, string> = {};
  for (const u of USERS) {
    let userId = await findAuthUserByEmail(u.email);
    if (!userId) {
      const { data, error } = await supabase.auth.admin.createUser({
        email: u.email,
        password: SEED_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: u.fullName },
      });
      if (error) throw new Error(`Gagal membuat auth user ${u.email}: ${error.message}`);
      userId = data.user.id;
      console.log(`[2] Auth user dibuat: ${u.email}`);
    } else {
      console.log(`[2] Auth user sudah ada: ${u.email}`);
    }

    const { error: profileErr } = await supabase.from("users").upsert(
      {
        id: userId,
        company_id: companyId,
        email: u.email,
        full_name: u.fullName,
        phone: u.phone,
        is_active: true,
      },
      { onConflict: "id" }
    );
    if (profileErr) throw new Error(`Gagal upsert profile ${u.email}: ${profileErr.message}`);

    const { data: roleRow, error: roleErr } = await supabase
      .from("roles").select("id").eq("name", u.role).is("company_id", null).single();
    if (roleErr || !roleRow) throw new Error(`Role ${u.role} tidak ditemukan`);

    const { error: urErr } = await supabase.from("user_roles").upsert(
      { user_id: userId, role_id: roleRow.id, company_id: companyId },
      { onConflict: "user_id,role_id,company_id" }
    );
    if (urErr) throw new Error(`Gagal assign role ${u.role} ke ${u.email}: ${urErr.message}`);
    console.log(`    role ${u.role} -> ${u.email}`);
    userIds[u.role] = userId;
  }

  // 3. Products
  for (const p of PRODUCTS) {
    const { error } = await supabase.from("products").upsert(
      { company_id: companyId, sku: p.sku, name: p.name, unit: p.unit, price: p.price, is_active: true },
      { onConflict: "company_id,sku" }
    );
    if (error) throw new Error(`Gagal upsert produk ${p.sku}: ${error.message}`);
  }
  console.log(`[3] ${PRODUCTS.length} produk master siap`);

  // 4. Customer
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .upsert(
      { company_id: companyId, ...CUSTOMER, assigned_sales_id: userIds["sales"], is_active: true },
      { onConflict: "company_id,code" }
    )
    .select("id")
    .single();
  if (custErr) throw new Error(`Gagal upsert customer: ${custErr.message}`);
  console.log(`[4] Customer siap: ${CUSTOMER.name}`);

  // 5. Satu sales_order hari ini untuk sales — bahan uji hybrid comparison
  const orderNumber = "SO-DEV-0001";
  const { data: existingOrder } = await supabase
    .from("sales_orders").select("id")
    .eq("company_id", companyId).eq("order_number", orderNumber).maybeSingle();

  if (!existingOrder) {
    const { error: orderErr } = await supabase.from("sales_orders").insert({
      company_id: companyId,
      order_number: orderNumber,
      customer_id: customer.id,
      sales_id: userIds["sales"],
      status: "confirmed",
      total_amount: 680000,
      discount_amount: 0,
      tax_amount: 0,
      final_amount: 680000,
      created_by: userIds["sales"],
    });
    if (orderErr) throw new Error(`Gagal membuat sales order: ${orderErr.message}`);
    console.log(`[5] Sales order ${orderNumber} dibuat (hybrid test)`);
  } else {
    console.log(`[5] Sales order ${orderNumber} sudah ada`);
  }

  console.log("\nSeed selesai.");
  console.log(`Login owner: owner@aodp.test / ${SEED_PASSWORD}`);
  console.log(`Login sales: sales@aodp.test / ${SEED_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
