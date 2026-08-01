/**
 * scripts/verify-demo-auth.ts
 *
 * Live verification auth/session/reset untuk AODP-Waluyo-Demo — melengkapi
 * verify-demo-rls.ts (yang fokus tenant isolation). Tidak pernah mencetak
 * password. Read-only kecuali langkah reset yang sengaja diuji (item 14/15
 * gate Demo Access & Tenant Branding): password Sales direset ke nilai uji
 * sementara lalu DIKEMBALIKAN ke nilai semula di akhir, dan skrip
 * memverifikasi login dengan password akhir sebelum keluar.
 */

import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "child_process";
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

let env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_DEMO_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Env demo tidak lengkap di .env.demo.local");
  process.exit(1);
}

const OWNER_EMAIL = "owner.demo@waluyo.aodp.test";
const ADMIN_EMAIL = "admin.demo@waluyo.aodp.test";
const SALES_EMAIL = "sales.demo@waluyo.aodp.test";

/** Baca role name via user_roles -> roles, PERSIS query yang dipakai getAuthUser() -- bukan user_metadata. */
async function readRoleNamesFromDb(
  client: ReturnType<typeof freshClient>,
  userId: string,
  companyId: string
): Promise<string[]> {
  const { data: userRolesData } = await client
    .from("user_roles")
    .select("role_id")
    .eq("user_id", userId)
    .eq("company_id", companyId);
  const roleIds = ((userRolesData ?? []) as { role_id: string }[]).map((r) => r.role_id);
  if (roleIds.length === 0) return [];
  const { data: rolesData } = await client.from("roles").select("name").in("id", roleIds);
  return ((rolesData ?? []) as { name: string }[]).map((r) => r.name);
}

const results: { name: string; pass: boolean; detail?: string }[] = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
}

function freshClient() {
  return createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function main() {
  // 1 & 2. Credential tersedia di environment
  record("1. AODP_DEMO_OWNER_PASSWORD tersedia di .env.demo.local", !!env.AODP_DEMO_OWNER_PASSWORD);
  record("2. AODP_DEMO_SALES_PASSWORD tersedia di .env.demo.local", !!env.AODP_DEMO_SALES_PASSWORD);

  // 3 & 4. Seed ulang tidak mengubah password
  const ownerPwBefore = env.AODP_DEMO_OWNER_PASSWORD;
  const salesPwBefore = env.AODP_DEMO_SALES_PASSWORD;
  execFileSync("npx", ["tsx", "scripts/seed-demo.ts"], { stdio: "pipe", shell: true, windowsHide: true });
  env = loadEnv();
  record(
    "3/4. Seed ulang TIDAK mengubah password owner/sales",
    env.AODP_DEMO_OWNER_PASSWORD === ownerPwBefore && env.AODP_DEMO_SALES_PASSWORD === salesPwBefore
  );

  // 5. Owner login berhasil
  const ownerClient = freshClient();
  {
    const { data, error } = await ownerClient.auth.signInWithPassword({ email: OWNER_EMAIL, password: env.AODP_DEMO_OWNER_PASSWORD });
    record("5. Owner Demo login berhasil (Supabase Auth nyata)", !error && !!data.session, error?.message);
  }

  // Invalid password ditolak
  {
    const c = freshClient();
    const { error } = await c.auth.signInWithPassword({ email: OWNER_EMAIL, password: "password-salah-sengaja-000" });
    record("Invalid password DITOLAK", !!error, error?.message);
  }

  // 6. Refresh/session verification
  {
    const { data: sessionData, error } = await ownerClient.auth.getSession();
    record("6. Session tersedia setelah login (getSession)", !error && !!sessionData.session, error?.message);
    const { data: refreshed, error: refreshErr } = await ownerClient.auth.refreshSession();
    record("6b. refreshSession() berhasil mempertahankan session", !refreshErr && !!refreshed.session, refreshErr?.message);
  }

  // 11. Branding setelah Owner login
  {
    const { data: userData } = await ownerClient.auth.getUser();
    const { data: profile } = await ownerClient.from("users").select("company_id").eq("id", userData.user!.id).single();
    const { data: company } = await ownerClient.from("companies").select("name, settings").eq("id", profile!.company_id).single();
    const nameOk = company?.name === "PT. Sumber Warna Alam Sudiada";
    const badgeOk = (company?.settings as Record<string, unknown> | null)?.environment === "DEMO";
    record("11. Branding: company name = 'PT. Sumber Warna Alam Sudiada'", nameOk, company?.name);
    record("12. Branding: settings.environment = 'DEMO' (badge)", badgeOk, JSON.stringify(company?.settings));
  }

  // 7. Logout
  {
    const { error } = await ownerClient.auth.signOut();
    record("7. Logout (signOut) berhasil", !error, error?.message);
  }

  // 8. Setelah logout, protected query ditolak
  {
    const { data, error } = await ownerClient.from("companies").select("id").limit(1);
    const blocked = !!error || (data?.length ?? 0) === 0;
    record("8. Setelah logout, query protected ditolak/kosong", blocked, error ? error.message : `rows=${data?.length}`);
  }

  // 9. Owner bisa login kembali dengan password yang sama
  {
    const c = freshClient();
    const { data, error } = await c.auth.signInWithPassword({ email: OWNER_EMAIL, password: env.AODP_DEMO_OWNER_PASSWORD });
    record("9. Owner login KEMBALI dengan password sama berhasil", !error && !!data.session, error?.message);
    await c.auth.signOut();
  }

  // 10. Sales login dengan password tetapnya
  {
    const c = freshClient();
    const { data, error } = await c.auth.signInWithPassword({ email: SALES_EMAIL, password: env.AODP_DEMO_SALES_PASSWORD });
    record("10. Sales Demo login berhasil dengan password tetap", !error && !!data.session, error?.message);
    await c.auth.signOut();
  }

  // 10b. Admin Demo login berhasil (Gate 3A — role baseline ketiga)
  {
    const c = freshClient();
    const { data, error } = await c.auth.signInWithPassword({ email: ADMIN_EMAIL, password: env.AODP_DEMO_ADMIN_PASSWORD });
    record("10b. Admin Demo login berhasil dengan Supabase Auth nyata", !error && !!data.session, error?.message);
    await c.auth.signOut();
  }

  // 13. Role owner/admin/sales terbaca dari user_roles/roles (canonical membership),
  // BUKAN dari user_metadata (yang dapat dimanipulasi client) -- query PERSIS meniru
  // getAuthUser() (apps/web/src/lib/auth/get-user.ts). Juga membuktikan ketiganya
  // berada di tenant demo yang SAMA.
  {
    const accounts: { label: string; email: string; passwordKey: string; expectedRole: string }[] = [
      { label: "Owner", email: OWNER_EMAIL, passwordKey: "AODP_DEMO_OWNER_PASSWORD", expectedRole: "owner" },
      { label: "Admin", email: ADMIN_EMAIL, passwordKey: "AODP_DEMO_ADMIN_PASSWORD", expectedRole: "admin" },
      { label: "Sales", email: SALES_EMAIL, passwordKey: "AODP_DEMO_SALES_PASSWORD", expectedRole: "sales" },
    ];
    const companyIds: string[] = [];
    for (const acc of accounts) {
      const c = freshClient();
      const { data: signInData, error: signInErr } = await c.auth.signInWithPassword({ email: acc.email, password: env[acc.passwordKey] });
      if (signInErr || !signInData.session) {
        record(`13. ${acc.label} Demo terbaca sebagai role '${acc.expectedRole}'`, false, signInErr?.message ?? "sign-in gagal");
        continue;
      }
      const { data: userData } = await c.auth.getUser();
      const { data: profile } = await c.from("users").select("company_id").eq("id", userData.user!.id).single();
      const companyId = (profile as { company_id: string } | null)?.company_id;
      const roles = companyId ? await readRoleNamesFromDb(c, userData.user!.id, companyId) : [];
      record(
        `13. ${acc.label} Demo terbaca sebagai role '${acc.expectedRole}' (dari user_roles/roles, bukan user_metadata)`,
        roles.length === 1 && roles[0] === acc.expectedRole,
        `roles=${JSON.stringify(roles)}`
      );
      if (companyId) companyIds.push(companyId);
      await c.auth.signOut();
    }
    const sameTenant = companyIds.length === accounts.length && companyIds.every((id) => id === companyIds[0]);
    record("13b. Owner/Admin/Sales Demo berada di tenant demo yang SAMA", sameTenant, `company_ids=${JSON.stringify(companyIds)}`);
  }

  // 14/15. Reset password eksplisit diuji dengan aman (Sales, risiko lebih rendah), lalu dikembalikan
  {
    const originalSalesPassword = env.AODP_DEMO_SALES_PASSWORD;
    const tempPassword = `TempReset-${Date.now()}-Aa1!`;

    // a) stage nilai baru, jalankan reset
    setEnvValue("AODP_DEMO_SALES_PASSWORD_NEW", tempPassword);
    let resetOk = true;
    let resetDetail = "";
    try {
      execFileSync("npx", ["tsx", "scripts/reset-demo-access.ts", "--account=sales"], { stdio: "pipe", shell: true, windowsHide: true });
    } catch (e) {
      resetOk = false;
      resetDetail = e instanceof Error ? e.message : String(e);
    }
    record("14. Reset password eksplisit (Sales) berhasil dijalankan", resetOk, resetDetail);

    // b) verifikasi login dengan password baru
    env = loadEnv();
    const c1 = freshClient();
    const { data: d1, error: e1 } = await c1.auth.signInWithPassword({ email: SALES_EMAIL, password: tempPassword });
    record("14b. Login berhasil dengan password hasil reset", !e1 && !!d1.session, e1?.message);
    await c1.auth.signOut();

    // c) kembalikan ke password semula
    setEnvValue("AODP_DEMO_SALES_PASSWORD_NEW", originalSalesPassword);
    let restoreOk = true;
    let restoreDetail = "";
    try {
      execFileSync("npx", ["tsx", "scripts/reset-demo-access.ts", "--account=sales"], { stdio: "pipe", shell: true, windowsHide: true });
    } catch (e) {
      restoreOk = false;
      restoreDetail = e instanceof Error ? e.message : String(e);
    }
    record("15. Restore password Sales ke nilai semula berhasil", restoreOk, restoreDetail);

    // d) verifikasi credential final di .env.demo.local kembali bisa dipakai
    env = loadEnv();
    const c2 = freshClient();
    const { data: d2, error: e2 } = await c2.auth.signInWithPassword({ email: SALES_EMAIL, password: env.AODP_DEMO_SALES_PASSWORD });
    record(
      "15b. Credential final di .env.demo.local kembali dapat dipakai login",
      !e2 && !!d2.session && env.AODP_DEMO_SALES_PASSWORD === originalSalesPassword,
      e2?.message
    );
    await c2.auth.signOut();
  }

  console.log("\n=== HASIL AUTH/SESSION/RESET VERIFICATION (AODP-Waluyo-Demo) ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} — ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const anyFail = results.some((r) => !r.pass);
  console.log(`\nRingkasan: ${results.filter((r) => r.pass).length}/${results.length} PASS`);
  process.exit(anyFail ? 1 : 0);
}

function setEnvValue(key: string, value: string): void {
  let current = fs.readFileSync(ENV_FILE, "utf-8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(current)) {
    current = current.replace(re, `${key}=${value}`);
  } else {
    current += `${current.endsWith("\n") || current === "" ? "" : "\n"}${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, current);
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
