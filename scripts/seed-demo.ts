/**
 * scripts/seed-demo.ts
 *
 * Seed sintetis untuk Supabase project AODP-Waluyo-Demo (Demo/Staging,
 * bukan production). Idempotent — aman dijalankan berulang.
 *
 * Membuat:
 *   - Tenant demo "PT. Sumber Warna Alam Sudiada" (settings.environment = "DEMO",
 *     settings.coverage_areas = wilayah awal Cirebon Timur/Kota/Barat)
 *   - Satu akun owner demo untuk tenant tsb (password acak, TIDAK di-log ke
 *     console — ditulis ke .env.demo.local sebagai DEMO_OWNER_PASSWORD)
 *   - Satu produk sintetis minimum (untuk verifikasi RLS pada tabel bisnis)
 *   - Satu tenant sintetis KEDUA + owner-nya, khusus untuk membuktikan
 *     tenant isolation (bukan data Waluyo)
 *
 * TIDAK membuat: toko/customer asli, transaksi asli, salesman/Telegram
 * enrollment (di luar scope gate ini).
 *
 * Env vars dibaca dari .env.demo.local (root repo):
 *   NEXT_PUBLIC_SUPABASE_DEMO_URL
 *   SUPABASE_DEMO_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const ENV_FILE = path.resolve(process.cwd(), ".env.demo.local");

function loadEnv(): void {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(".env.demo.local tidak ditemukan di root repo.");
    process.exit(1);
  }
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function appendEnvIfMissing(key: string, value: string): void {
  const current = fs.readFileSync(ENV_FILE, "utf-8");
  if (current.includes(`${key}=`)) return;
  fs.appendFileSync(ENV_FILE, `${key}=${value}\n`);
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_DEMO_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_DEMO_URL / SUPABASE_DEMO_SERVICE_ROLE_KEY belum ada di .env.demo.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_COMPANY = {
  name: "PT. Sumber Warna Alam Sudiada",
  slug: "sumber-warna-alam-sudiada-demo",
  coverageAreas: ["Cirebon Timur", "Cirebon Kota", "Cirebon Barat"],
};

const ISOLATION_COMPANY = {
  name: "PT. Isolation Test Tenant (Synthetic)",
  slug: "isolation-test-tenant-synthetic",
};

const DEMO_OWNER = {
  email: "owner.demo@waluyo.aodp.test",
  fullName: "Demo Owner — Waluyo",
  phone: "0812-0000-9001",
};

const ISOLATION_OWNER = {
  email: "owner.isolation@aodp.test",
  fullName: "Isolation Test Owner (Synthetic)",
  phone: "0812-0000-9002",
};

const DEMO_SALES = {
  email: "sales.demo@waluyo.aodp.test",
  fullName: "Demo Sales — Waluyo (RLS test only)",
  phone: "0812-0000-9003",
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

async function upsertCompany(spec: { name: string; slug: string; settings?: Record<string, unknown> }): Promise<string> {
  const { data: existing } = await supabase.from("companies").select("id").eq("slug", spec.slug).maybeSingle();
  if (existing?.id) {
    if (spec.settings) {
      await supabase.from("companies").update({ settings: spec.settings }).eq("id", existing.id);
    }
    console.log(`  company sudah ada: ${spec.name} (${existing.id})`);
    return existing.id as string;
  }
  const { data, error } = await supabase
    .from("companies")
    .insert({ name: spec.name, slug: spec.slug, settings: spec.settings ?? {} })
    .select("id")
    .single();
  if (error) throw new Error(`Gagal membuat company ${spec.name}: ${error.message}`);
  console.log(`  company dibuat: ${spec.name} (${data.id})`);
  return data.id as string;
}

async function upsertUserWithRole(
  companyId: string,
  spec: { email: string; fullName: string; phone: string },
  roleName: string
): Promise<{ userId: string; passwordCreated: boolean }> {
  let userId = await findAuthUserByEmail(spec.email);
  let passwordCreated = false;
  if (!userId) {
    const password = crypto.randomBytes(18).toString("base64url");
    const { data, error } = await supabase.auth.admin.createUser({
      email: spec.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: spec.fullName, environment: "DEMO" },
    });
    if (error) throw new Error(`Gagal membuat auth user ${spec.email}: ${error.message}`);
    userId = data.user.id;
    appendEnvIfMissing(
      `DEMO_OWNER_PASSWORD_${spec.email.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`,
      password
    );
    passwordCreated = true;
    console.log(`  auth user dibuat: ${spec.email} (password ditulis ke .env.demo.local, tidak ditampilkan)`);
  } else {
    console.log(`  auth user sudah ada: ${spec.email}`);
  }

  const { error: profileErr } = await supabase.from("users").upsert(
    { id: userId, company_id: companyId, email: spec.email, full_name: spec.fullName, phone: spec.phone, is_active: true },
    { onConflict: "id" }
  );
  if (profileErr) throw new Error(`Gagal upsert profile ${spec.email}: ${profileErr.message}`);

  const { data: roleRow, error: roleErr } = await supabase
    .from("roles")
    .select("id")
    .eq("name", roleName)
    .is("company_id", null)
    .single();
  if (roleErr || !roleRow) throw new Error(`Role '${roleName}' tidak ditemukan (migration belum lengkap?)`);

  const { error: urErr } = await supabase
    .from("user_roles")
    .upsert({ user_id: userId, role_id: roleRow.id, company_id: companyId }, { onConflict: "user_id,role_id,company_id" });
  if (urErr) throw new Error(`Gagal assign role ${roleName} ke ${spec.email}: ${urErr.message}`);

  return { userId, passwordCreated };
}

async function upsertSyntheticProduct(companyId: string, sku: string, name: string): Promise<void> {
  const { error } = await supabase
    .from("products")
    .upsert({ company_id: companyId, sku, name, unit: "pcs", price: 10000, is_active: true }, { onConflict: "company_id,sku" });
  if (error) throw new Error(`Gagal upsert produk sintetis ${sku}: ${error.message}`);
}

async function main() {
  console.log("[1] Tenant demo (Waluyo)");
  const demoCompanyId = await upsertCompany({
    name: DEMO_COMPANY.name,
    slug: DEMO_COMPANY.slug,
    settings: { environment: "DEMO", coverage_areas: DEMO_COMPANY.coverageAreas },
  });

  console.log("[2] Owner demo (Waluyo)");
  const demoOwner = await upsertUserWithRole(demoCompanyId, DEMO_OWNER, "owner");

  console.log("[3] Sales demo (Waluyo) — khusus uji RLS role sales, bukan Salesman Enrollment");
  const demoSales = await upsertUserWithRole(demoCompanyId, DEMO_SALES, "sales");

  console.log("[4] Produk sintetis (tenant demo)");
  await upsertSyntheticProduct(demoCompanyId, "DEMO-SKU-001", "Produk Sintetis Demo Waluyo");

  console.log("[5] Tenant sintetis kedua (untuk uji isolation)");
  const isolationCompanyId = await upsertCompany({ name: ISOLATION_COMPANY.name, slug: ISOLATION_COMPANY.slug });

  console.log("[6] Owner tenant isolation");
  const isolationOwner = await upsertUserWithRole(isolationCompanyId, ISOLATION_OWNER, "owner");

  console.log("[7] Produk sintetis (tenant isolation)");
  await upsertSyntheticProduct(isolationCompanyId, "ISO-SKU-001", "Produk Sintetis Isolation Tenant");

  console.log("\nSeed demo selesai.");
  console.log(
    JSON.stringify(
      {
        demo_company_id: demoCompanyId,
        demo_owner_user_id: demoOwner.userId,
        demo_sales_user_id: demoSales.userId,
        isolation_company_id: isolationCompanyId,
        isolation_owner_user_id: isolationOwner.userId,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
