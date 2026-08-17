// =============================================================================
// DB-backed integration test -- logAuditEvent() kontrak kanonis (Gate 1D-A
// migration 20260819000001: actor_type/event_category/module/source/outcome).
//
// Konteks: 22 titik pemanggilan logAuditEvent() lintas modul (Produk,
// Pelanggan, Platform, Laporan Sales, Import Data, Pengguna, Auth) sebelumnya
// tidak pernah mengisi kolom kanonis ini sama sekali -- tercatat `partial` di
// docs/owner-control/ACTIVITY_AUDIT_COVERAGE_MATRIX.md. Fix murni menambah
// field `module` (WAJIB, dipaksa TypeScript) + default event_category=audit/
// source=web/outcome=success (bisa ditimpa eksplisit, mis. event_category=
// security utk login/logout) pada helper bersama -- test ini membuktikan
// mekanismenya (default & override) benar-benar tersimpan di Postgres,
// bukan cuma lolos type-check.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia,
// ATAU kalau URL yang terbaca BUKAN loopback -- pola sama seluruh integration
// test DB-backed lain di repo ini.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
    : readDotEnvLocal();

  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("DB integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
} else {
  // getAdminClient() di lib/supabase/admin.ts membaca process.env langsung --
  // pastikan terisi sebelum logAuditEvent() (yang memanggilnya secara
  // internal) dipanggil test di bawah, terlepas dari bagaimana env
  // ter-load (langsung dari process.env atau fallback .env.local).
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.serviceRoleKey;
}

describeIfDb("logAuditEvent -- kontrak kanonis (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let ownerAuthId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerAuth, error: ownerErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (ownerErr || !ownerAuth.user) throw new Error(`gagal buat auth user: ${ownerErr?.message}`);
    ownerAuthId = ownerAuth.user.id;

    await supabase.from("companies").insert({ id: companyId, name: `Verify Audit Co ${runTag}`, slug: `verify-audit-${runTag}` });
    await supabase.from("users").insert({ id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("audit_logs").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("id", ownerAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
  }, 30000);

  it("1. module WAJIB tersimpan, event_category/source/outcome default ke audit/web/success bila tidak diisi eksplisit", async () => {
    const { logAuditEvent } = await import("./audit");
    await logAuditEvent({
      company_id: companyId, user_id: ownerAuthId, action: "product.create",
      entity_type: "product", entity_id: randomUUID(), new_data: { name: "Test" },
      module: "products",
    });

    const { data } = await supabase.from("audit_logs")
      .select("*").eq("company_id", companyId).eq("action", "product.create").single();
    const row = data as { module: string; event_category: string; source: string; outcome: string; actor_type: string | null };
    expect(row.module).toBe("products");
    expect(row.event_category).toBe("audit");
    expect(row.source).toBe("web");
    expect(row.outcome).toBe("success");
    expect(row.actor_type).toBeNull();
  });

  it("2. event_category override (mis. security utk login/logout) tersimpan, bukan default audit", async () => {
    const { logAuditEvent } = await import("./audit");
    await logAuditEvent({
      company_id: companyId, user_id: ownerAuthId, action: "login",
      entity_type: "session", new_data: { email: "test@verify.test" },
      module: "auth", event_category: "security",
    });

    const { data } = await supabase.from("audit_logs")
      .select("module, event_category").eq("company_id", companyId).eq("action", "login").single();
    const row = data as { module: string; event_category: string };
    expect(row.module).toBe("auth");
    expect(row.event_category).toBe("security");
  });

  it("3. module berbeda per aksi tersimpan berbeda pula (customers vs platform vs reports vs imports vs users) -- bukti tidak ada nilai hardcoded/tertukar", async () => {
    const { logAuditEvent } = await import("./audit");
    const cases: Array<{ action: string; module: string }> = [
      { action: "customer.update", module: "customers" },
      { action: "tenant.create", module: "platform" },
      { action: "sales_report.create", module: "reports" },
      { action: "import.uploaded", module: "imports" },
      { action: "salesman.created", module: "users" },
    ];
    for (const c of cases) {
      await logAuditEvent({
        company_id: companyId, user_id: ownerAuthId, action: c.action,
        entity_type: "test_entity", module: c.module,
      });
    }

    const { data } = await supabase.from("audit_logs")
      .select("action, module").eq("company_id", companyId).in("action", cases.map((c) => c.action));
    const rows = (data ?? []) as { action: string; module: string }[];
    expect(rows).toHaveLength(cases.length);
    for (const c of cases) {
      expect(rows.find((r) => r.action === c.action)?.module).toBe(c.module);
    }
  });
});
