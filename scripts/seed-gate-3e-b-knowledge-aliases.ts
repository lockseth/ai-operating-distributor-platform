/**
 * scripts/seed-gate-3e-b-knowledge-aliases.ts
 *
 * Gate 3E-B — Telegram Sales Order Live Demo Readiness. Gap ditemukan saat
 * audit: dataset Gate 3E-A (scripts/seed-gate-3e-a-dataset.ts) membuat baris
 * `products`/`customers` sungguhan untuk tenant demo "PT. Sumber Warna Alam
 * Sudiada", TAPI tidak pernah mengisi `knowledge_product_aliases`/
 * `knowledge_customer_aliases`. Tanpa baris Knowledge Pack ini,
 * resolveProductId()/resolveCustomerId() (apps/web/src/lib/sales-orders/
 * pricing.ts) TIDAK PERNAH bisa mencocokkan nama yang diketik sales di
 * Telegram ke `products`/`customers` asli — setiap order demo akan selalu
 * jatuh ke fallback product_name_raw/customer_name_raw (teks bebas, TIDAK
 * tertaut ke master toko/produk tervalidasi), yang bertentangan dengan
 * tujuan Gate 3E-B ("toko/produk tervalidasi").
 *
 * Script ini HANYA menambah baris alias yang menunjuk ke `products`/
 * `customers` yang SUDAH ADA (dibuat Gate 3E-A) -- tidak membuat toko/produk
 * baru, tidak membuat source of truth kedua (DEMO FIXTURE Gate 3E-B).
 *
 * Idempotent: upsert per (company_id, alias_text) -- unique constraint yang
 * sudah ada di kedua tabel (migration 20260709000001). Rerun aman.
 *
 * BELUM DIJALANKAN terhadap Supabase demo hosted sebagai bagian dari sesi
 * Gate 3E-B ini (menulis ke sistem hosted/shared di luar scope audit ini,
 * lihat AODP_GATE_3E_B_TELEGRAM_LIVE_DEMO_READINESS_RUNBOOK.md, bagian
 * "Langkah Operator Wajib") -- dijalankan manual oleh operator SEBELUM Gate 3E-C.
 *
 * Run: pnpm tsx scripts/seed-gate-3e-b-knowledge-aliases.ts
 */

import { createClient } from "@supabase/supabase-js";
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

const COMPANY_SLUG = "sumber-warna-alam-sudiada-demo";

// alias_text -> sku produk (harus sama persis dengan yang dipakai
// seed-gate-3e-a-dataset.ts PRODUCTS[].sku). Disimpan lowercase (konvensi
// kolom, lihat migration 20260709000001) -- pencocokan tetap case-insensitive
// lewat normalizeAliasKey() di kedua sisi (lib/sales-orders/normalize.ts).
const PRODUCT_ALIASES: { aliasText: string; sku: string }[] = [
  { aliasText: "cat tembok 5kg", sku: "SWA-CAT-5KG" },
  { aliasText: "cat tembok sumber warna 5kg", sku: "SWA-CAT-5KG" },
  { aliasText: "cat tembok 25kg", sku: "SWA-CAT-25KG" },
  { aliasText: "cat tembok sumber warna 25kg", sku: "SWA-CAT-25KG" },
  { aliasText: "cat kayu besi", sku: "SWA-CAT-KB-1L" },
  { aliasText: "cat kayu besi 1l", sku: "SWA-CAT-KB-1L" },
  { aliasText: "thinner", sku: "SWA-THINNER-1L" },
  { aliasText: "thinner 1l", sku: "SWA-THINNER-1L" },
];

// alias_text -> nama toko (harus sama persis dengan STORES[].name di
// seed-gate-3e-a-dataset.ts, dipakai sebagai natural key lookup ke `customers`).
const CUSTOMER_ALIASES: { aliasText: string; storeName: string }[] = [
  { aliasText: "toko berkah jaya", storeName: "Toko Bangunan Berkah Jaya" },
  { aliasText: "berkah jaya", storeName: "Toko Bangunan Berkah Jaya" },
  { aliasText: "toko sumber makmur", storeName: "Toko Sumber Makmur Cat & Bangunan" },
  { aliasText: "sumber makmur", storeName: "Toko Sumber Makmur Cat & Bangunan" },
  { aliasText: "mitra sejahtera", storeName: "Warung Material Mitra Sejahtera" },
  { aliasText: "toko cahaya abadi", storeName: "Toko Cahaya Abadi Bangunan" },
  { aliasText: "cahaya abadi", storeName: "Toko Cahaya Abadi Bangunan" },
  { aliasText: "toko anugerah baru", storeName: "Toko Anugerah Baru" },
  { aliasText: "anugerah baru", storeName: "Toko Anugerah Baru" },
];

async function main() {
  console.log("[0] Resolusi company demo + owner");
  const { data: company, error: companyErr } = await supabase
    .from("companies")
    .select("id")
    .eq("slug", COMPANY_SLUG)
    .maybeSingle();
  if (companyErr || !company?.id) {
    throw new Error(`Company demo (slug=${COMPANY_SLUG}) tidak ditemukan — jalankan seed-demo.ts + seed-gate-3e-a-dataset.ts dulu.`);
  }
  const companyId = company.id as string;

  const { data: owner, error: ownerErr } = await supabase
    .from("users")
    .select("id")
    .eq("company_id", companyId)
    .eq("email", "owner.demo@waluyo.aodp.test")
    .single();
  if (ownerErr || !owner?.id) {
    throw new Error("Owner demo tidak ditemukan — jalankan seed-demo.ts dulu.");
  }
  const ownerId = owner.id as string;
  console.log(`  company=${companyId} owner=${ownerId}`);

  console.log("[1] Knowledge product aliases");
  for (const alias of PRODUCT_ALIASES) {
    const { data: product, error: productErr } = await supabase
      .from("products")
      .select("id")
      .eq("company_id", companyId)
      .eq("sku", alias.sku)
      .single();
    if (productErr || !product?.id) {
      throw new Error(`Produk sku=${alias.sku} tidak ditemukan — jalankan seed-gate-3e-a-dataset.ts dulu.`);
    }
    const { error: upsertErr } = await supabase
      .from("knowledge_product_aliases")
      .upsert(
        {
          company_id: companyId,
          alias_text: alias.aliasText,
          product_id: product.id,
          is_active: true,
          created_by: ownerId,
        },
        { onConflict: "company_id,alias_text" },
      );
    if (upsertErr) throw new Error(`Gagal upsert product alias "${alias.aliasText}": ${upsertErr.message}`);
    console.log(`  alias "${alias.aliasText}" -> ${alias.sku} (${product.id})`);
  }

  console.log("[2] Knowledge customer aliases");
  for (const alias of CUSTOMER_ALIASES) {
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("id")
      .eq("company_id", companyId)
      .eq("name", alias.storeName)
      .single();
    if (customerErr || !customer?.id) {
      throw new Error(`Toko "${alias.storeName}" tidak ditemukan — jalankan seed-gate-3e-a-dataset.ts dulu.`);
    }
    const { error: upsertErr } = await supabase
      .from("knowledge_customer_aliases")
      .upsert(
        {
          company_id: companyId,
          alias_text: alias.aliasText,
          customer_id: customer.id,
          is_active: true,
          created_by: ownerId,
        },
        { onConflict: "company_id,alias_text" },
      );
    if (upsertErr) throw new Error(`Gagal upsert customer alias "${alias.aliasText}": ${upsertErr.message}`);
    console.log(`  alias "${alias.aliasText}" -> ${alias.storeName} (${customer.id})`);
  }

  console.log("\n=== SEED GATE 3E-B KNOWLEDGE ALIASES SELESAI ===");
  console.log(`  ${PRODUCT_ALIASES.length} product alias, ${CUSTOMER_ALIASES.length} customer alias, company_id=${companyId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
