/**
 * scripts/verify-demo-rls.ts
 *
 * Live RLS / tenant-isolation smoke test terhadap AODP-Waluyo-Demo.
 * Read-only kecuali satu percobaan UPDATE cross-tenant yang harus DITOLAK
 * (dan diverifikasi tidak berubah). Tidak pernah mencetak password/secret —
 * hanya PASS/FAIL per skenario.
 *
 * Prasyarat: scripts/seed-demo.ts sudah dijalankan (owner/sales demo +
 * owner isolation tenant tersedia di .env.demo.local).
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const ENV_FILE = path.resolve(process.cwd(), ".env.demo.local");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_DEMO_ANON_KEY;
const SERVICE_KEY = env.SUPABASE_DEMO_SERVICE_ROLE_KEY;

const DEMO_OWNER_EMAIL = "owner.demo@waluyo.aodp.test";
const DEMO_ADMIN_EMAIL = "admin.demo@waluyo.aodp.test";
const DEMO_SALES_EMAIL = "sales.demo@waluyo.aodp.test";
const ISOLATION_OWNER_EMAIL = "owner.isolation@aodp.test";

function pwKeyFor(email: string): string {
  if (email === DEMO_OWNER_EMAIL) return "AODP_DEMO_OWNER_PASSWORD";
  if (email === DEMO_ADMIN_EMAIL) return "AODP_DEMO_ADMIN_PASSWORD";
  if (email === DEMO_SALES_EMAIL) return "AODP_DEMO_SALES_PASSWORD";
  return `DEMO_OWNER_PASSWORD_${email.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error("Env demo tidak lengkap di .env.demo.local");
  process.exit(1);
}

const results: { name: string; pass: boolean; detail?: string }[] = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
}

async function signIn(email: string): Promise<ReturnType<typeof createClient>> {
  const password = env[pwKeyFor(email)];
  if (!password) throw new Error(`Password untuk ${email} tidak ada di .env.demo.local`);
  const client = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in gagal untuk ${email}: ${error.message}`);
  return client;
}

async function main() {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: demoCompany } = await admin.from("companies").select("id").eq("slug", "sumber-warna-alam-sudiada-demo").single();
  const { data: isolationCompany } = await admin.from("companies").select("id").eq("slug", "isolation-test-tenant-synthetic").single();
  if (!demoCompany || !isolationCompany) throw new Error("Seed belum lengkap — jalankan seed-demo.ts dulu.");

  // 1. Unauthenticated tidak dapat mengakses protected tables
  {
    const anon = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await anon.from("companies").select("id, name").limit(5);
    const blocked = !!error || (data?.length ?? 0) === 0;
    record("1. Unauthenticated ditolak dari tabel protected (companies)", blocked, error ? error.message : `rows=${data?.length}`);
  }

  // 2. Tenant Demo dapat membaca data miliknya
  const ownerClient = await signIn(DEMO_OWNER_EMAIL);
  {
    const { data, error } = await ownerClient.from("companies").select("id, name, settings").eq("id", demoCompany.id).maybeSingle();
    record("2. Owner Demo dapat membaca company miliknya", !error && !!data, error?.message);
  }
  {
    const { data, error } = await ownerClient.from("products").select("id, sku").eq("company_id", demoCompany.id);
    record("2b. Owner Demo dapat membaca produk sintetis miliknya", !error && (data?.length ?? 0) >= 1, error?.message);
  }

  // 2c. Admin Demo (role baseline ketiga Gate 3A) dapat membaca tenant miliknya sendiri
  const adminClient = await signIn(DEMO_ADMIN_EMAIL);
  {
    const { data, error } = await adminClient.from("companies").select("id, name").eq("id", demoCompany.id).maybeSingle();
    record("2c. Admin Demo dapat membaca company miliknya", !error && !!data, error?.message);
  }
  {
    const { data, error } = await adminClient.from("companies").select("id").eq("id", isolationCompany.id).maybeSingle();
    const blocked = !error && !data;
    record("2d. Admin Demo TIDAK dapat membaca company tenant lain (isolation)", blocked, error ? error.message : `data=${JSON.stringify(data)}`);
  }

  // 3. Tenant lain tidak dapat membaca data Demo
  const isolationOwnerClient = await signIn(ISOLATION_OWNER_EMAIL);
  {
    const { data, error } = await isolationOwnerClient.from("companies").select("id, name").eq("id", demoCompany.id).maybeSingle();
    const blocked = !error && !data;
    record("3. Tenant isolation TIDAK dapat membaca company Demo", blocked, error ? error.message : `data=${JSON.stringify(data)}`);
  }
  {
    const { data, error } = await isolationOwnerClient.from("products").select("id").eq("company_id", demoCompany.id);
    const blocked = !error && (data?.length ?? 0) === 0;
    record("3b. Tenant isolation TIDAK dapat membaca produk Demo", blocked, error ? error.message : `rows=${data?.length}`);
  }
  {
    const { data, error } = await isolationOwnerClient.from("users").select("id, email").eq("company_id", demoCompany.id);
    const blocked = !error && (data?.length ?? 0) === 0;
    record("3c. Tenant isolation TIDAK dapat membaca users Demo", blocked, error ? error.message : `rows=${data?.length}`);
  }

  // 4. Tenant lain tidak dapat mengubah data Demo
  {
    const { data: beforeAdmin } = await admin.from("companies").select("name").eq("id", demoCompany.id).single();
    const { error: updErr } = await isolationOwnerClient
      .from("companies")
      .update({ name: "TAMPERED-BY-ISOLATION-TENANT" })
      .eq("id", demoCompany.id);
    const { data: afterAdmin } = await admin.from("companies").select("name").eq("id", demoCompany.id).single();
    const unchanged = afterAdmin?.name === beforeAdmin?.name;
    record("4. Tenant isolation TIDAK dapat mengubah company Demo", unchanged, updErr ? updErr.message : `unchanged=${unchanged}`);
  }

  // 5. Role sales tidak memperoleh akses admin (mis. insert user baru di tenant sendiri)
  const salesClient = await signIn(DEMO_SALES_EMAIL);
  {
    const { error } = await salesClient.from("users").insert({
      id: "00000000-0000-0000-0000-000000000099",
      company_id: demoCompany.id,
      email: "should-not-be-created@waluyo.aodp.test",
      full_name: "Should Not Be Created",
      is_active: true,
    });
    record("5. Role sales TIDAK dapat insert users baru (admin-only)", !!error, error?.message);
  }
  {
    // Cleanup in case RLS somehow allowed it (would indicate FAIL above) — admin-only, safe no-op if nothing inserted.
    await admin.from("users").delete().eq("id", "00000000-0000-0000-0000-000000000099");
  }

  console.log("\n=== HASIL RLS / TENANT ISOLATION TEST (AODP-Waluyo-Demo) ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const anyFail = results.some((r) => !r.pass);
  console.log(`\nRingkasan: ${results.filter((r) => r.pass).length}/${results.length} PASS`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
