/**
 * scripts/gate-2i5-verify.ts
 *
 * Read-only backend evidence helper untuk Gate 2I.5 (Browser E2E UAT).
 * Tidak melakukan mutation apapun -- hanya query verifikasi lewat
 * service_role client, dipakai memverifikasi row count/ledger/audit
 * setelah aksi dilakukan lewat browser.
 *
 * Run: pnpm tsx scripts/gate-2i5-verify.ts <cmd> [...args]
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
    break;
  }
}
loadEnv();

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "table") {
    const [table, col, val] = [args[1], args[2], args[3]];
    const { data, error } = await supabase.from(table).select("*").eq(col, val);
    console.log(JSON.stringify({ count: data?.length, data, error }, null, 2));
  }

  if (cmd === "audit") {
    const [action, entityId] = [args[1], args[2]];
    let q = supabase.from("audit_logs").select("id, action, entity_type, entity_id, module, created_at, actor_type, event_category, outcome").order("created_at", { ascending: false }).limit(50);
    if (action && action !== "-") q = q.eq("action", action);
    if (entityId && entityId !== "-") q = q.eq("entity_id", entityId);
    const { data, error } = await q;
    console.log(JSON.stringify({ count: data?.length, data, error }, null, 2));
  }

  if (cmd === "balance") {
    const invoiceId = args[1];
    const { data, error } = await supabase.from("invoice_receivable_balances").select("*").eq("id", invoiceId);
    console.log(JSON.stringify({ data, error }, null, 2));
  }

  if (cmd === "creditbalance") {
    const creditNoteId = args[1];
    const { data, error } = await supabase.from("customer_credit_balances").select("*").eq("credit_note_id", creditNoteId);
    console.log(JSON.stringify({ data, error }, null, 2));
  }

  if (cmd === "count") {
    const [table, col, val] = [args[1], args[2], args[3]];
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).eq(col, val);
    console.log(JSON.stringify({ table, col, val, count, error }, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
