/**
 * scripts/reset-demo-access.ts
 *
 * Reset password EKSPLISIT untuk satu akun Demo (owner ATAU sales) di
 * Supabase AODP-Waluyo-Demo. Tidak pernah berjalan otomatis (tidak dipanggil
 * dari seed-demo.ts). Fail-closed: berhenti dengan error jika target
 * project, allowlist email, atau password baru tidak tersedia — TIDAK
 * PERNAH membuat password sendiri.
 *
 * Usage:
 *   tsx scripts/reset-demo-access.ts --account=owner
 *   tsx scripts/reset-demo-access.ts --account=sales
 *
 * Prasyarat di .env.demo.local (gitignored):
 *   NEXT_PUBLIC_SUPABASE_DEMO_URL        (wajib, harus project ref Demo)
 *   SUPABASE_DEMO_SERVICE_ROLE_KEY       (wajib)
 *   AODP_DEMO_OWNER_EMAIL / AODP_DEMO_SALES_EMAIL   (allowlist email)
 *   AODP_DEMO_OWNER_PASSWORD_NEW  atau  AODP_DEMO_SALES_PASSWORD_NEW
 *     -> password BARU yang ingin dipasang. Operator yang menentukan
 *        nilainya (mis. isi manual di .env.demo.local); script ini TIDAK
 *        pernah generate password sendiri.
 *
 * Setelah sukses: kunci *_NEW dihapus dari file, kunci kanonik
 * AODP_DEMO_OWNER_PASSWORD / AODP_DEMO_SALES_PASSWORD diperbarui ke nilai
 * baru tsb (tanpa pernah mencetak nilainya).
 *
 * Tidak membuat endpoint HTTP apa pun — murni CLI/server-side admin tool.
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import {
  isValidDemoProjectHost,
  isAllowedDemoEmail,
  assertNewPasswordProvided,
  buildResetSuccessMessage,
  buildResetFailureMessage,
  DEMO_ALLOWED_EMAILS,
  type DemoAccount,
} from "../apps/web/src/lib/demo-access/reset-rules";

const ENV_FILE = path.resolve(process.cwd(), ".env.demo.local");

type Account = DemoAccount;

function parseAccountArg(): Account {
  const arg = process.argv.find((a) => a.startsWith("--account="));
  const value = arg?.split("=")[1];
  if (value !== "owner" && value !== "sales") {
    console.error("FAIL: argumen --account=owner|sales wajib diisi eksplisit.");
    process.exit(1);
  }
  return value;
}

function loadEnv(): void {
  if (!fs.existsSync(ENV_FILE)) {
    console.error("FAIL: .env.demo.local tidak ditemukan di root repo.");
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

function removeEnvKey(key: string): void {
  let current = fs.readFileSync(ENV_FILE, "utf-8");
  const re = new RegExp(`^${key}=.*\\n?`, "m");
  current = current.replace(re, "");
  fs.writeFileSync(ENV_FILE, current);
}

async function main() {
  const account = parseAccountArg();
  loadEnv();

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_DEMO_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("FAIL: NEXT_PUBLIC_SUPABASE_DEMO_URL / SUPABASE_DEMO_SERVICE_ROLE_KEY tidak tersedia.");
    process.exit(1);
  }

  // Target project HARUS persis AODP-Waluyo-Demo — cegah reset tidak sengaja
  // menimpa project lain (mis. jika .env.demo.local pernah diarahkan salah).
  let hostname: string | null = null;
  try {
    hostname = new URL(SUPABASE_URL).hostname;
  } catch {
    hostname = null;
  }
  if (!isValidDemoProjectHost(hostname)) {
    console.error(buildResetFailureMessage("target project bukan AODP-Waluyo-Demo (ref terdeteksi tidak cocok). Reset dibatalkan."));
    process.exit(1);
  }

  const emailEnvKey = account === "owner" ? "AODP_DEMO_OWNER_EMAIL" : "AODP_DEMO_SALES_EMAIL";
  const newPasswordEnvKey = account === "owner" ? "AODP_DEMO_OWNER_PASSWORD_NEW" : "AODP_DEMO_SALES_PASSWORD_NEW";
  const canonicalPasswordEnvKey = account === "owner" ? "AODP_DEMO_OWNER_PASSWORD" : "AODP_DEMO_SALES_PASSWORD";

  // Allowlist eksplisit — hanya dua email Demo yang boleh direset, tidak ada
  // jalur untuk mereset akun lain lewat argumen ini.
  const email = process.env[emailEnvKey] || DEMO_ALLOWED_EMAILS[account];
  if (!isAllowedDemoEmail(account, email)) {
    console.error(buildResetFailureMessage(`email pada ${emailEnvKey} tidak cocok dengan allowlist akun Demo. Reset dibatalkan.`));
    process.exit(1);
  }

  let newPassword: string;
  try {
    newPassword = assertNewPasswordProvided(process.env[newPasswordEnvKey]);
  } catch {
    console.error(
      buildResetFailureMessage(
        `${newPasswordEnvKey} kosong/tidak diset di .env.demo.local. Script ini tidak membuat password sendiri — isi dulu nilai barunya secara eksplisit.`
      )
    );
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Cari user existing — reset HANYA berlaku untuk akun yang sudah ada,
  // tidak pernah membuat akun baru.
  let userId: string | null = null;
  let page = 1;
  const perPage = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      console.error(`FAIL: listUsers gagal (${error.message}).`);
      process.exit(1);
    }
    const found = data.users.find((u) => u.email === email);
    if (found) {
      userId = found.id;
      break;
    }
    if (!data.users.length || data.users.length < perPage) break;
    page++;
  }

  if (!userId) {
    console.error(buildResetFailureMessage(`akun ${email} tidak ditemukan di AODP-Waluyo-Demo. Reset dibatalkan (tidak membuat akun baru).`));
    process.exit(1);
  }

  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
  if (updateErr) {
    console.error(buildResetFailureMessage(`reset password gagal untuk ${email} (${updateErr.message}).`));
    process.exit(1);
  }

  setEnvValue(canonicalPasswordEnvKey, newPassword);
  removeEnvKey(newPasswordEnvKey);

  console.log(buildResetSuccessMessage(email, canonicalPasswordEnvKey));
}

main().catch((err) => {
  console.error(buildResetFailureMessage(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
