/**
 * scripts/verify-gate-3e-a.ts
 *
 * Read-only verification untuk Gate 3E-A (Demo Identity & Dataset
 * Provisioning). Tidak pernah menulis/mengubah data, tidak pernah mencetak
 * password/secret. Membuktikan: 4 identitas terhubung ke company + role yang
 * tepat, >=5 toko, >=5 order, tepat 2 order historis ~14 hari, dan
 * cardinality (untuk dibandingkan sebelum/sesudah rerun guna membuktikan
 * idempotency dari luar proses seed).
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
const SERVICE_KEY = env.SUPABASE_DEMO_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Env demo tidak lengkap di .env.demo.local");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const COMPANY_SLUG = "sumber-warna-alam-sudiada-demo";

const results: { name: string; pass: boolean; detail?: string }[] = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
}

async function main() {
  const { data: company } = await supabase.from("companies").select("id").eq("slug", COMPANY_SLUG).single();
  if (!company) throw new Error("Company demo tidak ditemukan.");
  const companyId = company.id as string;

  const ACCOUNTS = [
    { email: "owner.demo@waluyo.aodp.test", role: "owner" },
    { email: "admin.demo@waluyo.aodp.test", role: "admin" },
    { email: "sales.demo@waluyo.aodp.test", role: "sales" },
    { email: "sales2.demo@waluyo.aodp.test", role: "sales" },
  ];
  for (const acc of ACCOUNTS) {
    const { data: user } = await supabase.from("users").select("id, company_id, is_active").eq("email", acc.email).maybeSingle();
    const correctCompany = user?.company_id === companyId && user?.is_active === true;
    record(`Identitas: ${acc.email} terhubung ke company demo + aktif`, correctCompany, JSON.stringify(user));

    if (user) {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("roles(name)")
        .eq("user_id", user.id)
        .eq("company_id", companyId);
      const roleNames = (roles ?? []).map((r: any) => r.roles?.name);
      record(`Identitas: ${acc.email} punya role '${acc.role}'`, roleNames.length === 1 && roleNames[0] === acc.role, JSON.stringify(roleNames));
    }
  }

  const { data: stores, count: storeCount } = await supabase
    .from("customers")
    .select("id, name, assigned_sales_id", { count: "exact" })
    .eq("company_id", companyId);
  record("Minimal 5 toko (customers) tersedia", (storeCount ?? 0) >= 5, `count=${storeCount}`);

  const distinctSales = new Set((stores ?? []).map((s: any) => s.assigned_sales_id));
  record("Toko tersebar ke minimal 2 sales berbeda", distinctSales.size >= 2, `distinct_sales=${distinctSales.size}`);

  const { data: orders, count: orderCount } = await supabase
    .from("sales_orders")
    .select("id, order_number, created_at, status", { count: "exact" })
    .eq("company_id", companyId)
    .like("order_number", "SO-DEMO-WALUYO-%");
  record("Minimal 5 order (sales_orders) tersedia", (orderCount ?? 0) >= 5, `count=${orderCount}`);

  const now = Date.now();
  const historicalOrders = (orders ?? []).filter((o: any) => {
    const days = (now - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24);
    return days >= 12 && days <= 16;
  });
  record("Tepat 2 order dengan created_at ~14 hari sebelum sekarang", historicalOrders.length === 2, `matched=${historicalOrders.map((o: any) => o.order_number).join(",")}`);

  const { data: dispute } = await supabase
    .from("order_cancellation_disputes")
    .select("id, request_type, status")
    .eq("company_id", companyId)
    .eq("request_type", "CUSTOMER_DENIES_ORDER")
    .maybeSingle();
  // RPC create_order_cancellation_dispute mengklasifikasikan CUSTOMER_DENIES_ORDER
  // sebagai ai_classification HOLD_AND_ALERT -> status awal ON_HOLD (bukan REQUESTED)
  // -- lihat 20260822000001_order_lifecycle_audit_atomic.sql:158-159. Keduanya
  // "belum diresolve" (bukan APPROVED/REJECTED/RESOLVED), cocok untuk demo live.
  const openStatuses = ["REQUESTED", "ON_HOLD"];
  record(
    "Skenario toko meragukan: dispute CUSTOMER_DENIES_ORDER ada & belum diresolve",
    !!dispute && openStatuses.includes(dispute.status as string),
    JSON.stringify(dispute),
  );

  const { data: areas, count: areaCount } = await supabase
    .from("coverage_areas")
    .select("id", { count: "exact" })
    .eq("company_id", companyId);
  record("Coverage areas = 3 (tidak menggandakan tiap rerun)", (areaCount ?? 0) === 3, `count=${areaCount}`);

  console.log("\n=== HASIL VERIFIKASI GATE 3E-A ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const anyFail = results.some((r) => !r.pass);
  console.log(`\nRingkasan: ${results.filter((r) => r.pass).length}/${results.length} PASS`);

  console.log(
    "\nCARDINALITY_SNAPSHOT=" +
      JSON.stringify({
        stores: storeCount,
        orders: orderCount,
        areas: areaCount,
      }),
  );

  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
