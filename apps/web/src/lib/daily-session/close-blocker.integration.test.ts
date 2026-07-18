// =============================================================================
// DB-backed integration test -- close_daily_session blocker (Phase 7,
// migration 20260810000003). Membuktikan blocker delivery non-terminal
// benar-benar menyala di Postgres nyata: tidak bisa dibuktikan InMemory
// karena logic-nya hidup sebagai bagian RPC SQL, bukan kode TypeScript.
// Skip graceful jika Supabase lokal tidak tersedia -- pola sama dengan
// repository.integration.test.ts.
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
    text
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
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
}

describeIfDb("close_daily_session blocker -- 21/22 (Tutup Hari ditolak/berhasil, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const customerId = randomUUID();
  const salesOrderId = randomUUID();
  let salesAuthId = "";
  let deliveryId = "";
  let sessionId = "";
  const businessDate = "2026-08-05";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const salesRoleId = (salesRole as { id: string }).id;

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@verify.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user sales: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;

    await supabase.from("companies").insert({ id: companyId, name: `Verify Close Blocker Co ${runTag}`, slug: `verify-close-blocker-${runTag}` });
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true });
    await supabase.from("user_roles").insert({ user_id: salesAuthId, company_id: companyId, role_id: salesRoleId });
    await supabase.from("customers").insert({ id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify", assigned_sales_id: salesAuthId, is_active: true });
    await supabase.from("sales_orders").insert({
      id: salesOrderId, company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId,
      sales_id: salesAuthId, status: "confirmed", order_source: "FIELD_VISIT", is_historical: false,
    });

    const { data: startData } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: businessDate,
      p_idempotency_key: `${runTag}-start`,
    });
    sessionId = ((startData ?? [])[0] as { result_session_id: string }).result_session_id;

    const { data: deliveryRow } = await supabase
      .from("deliveries")
      .insert({ company_id: companyId, sales_order_id: salesOrderId, assigned_driver_id: salesAuthId, status: "dispatched" })
      .select("id")
      .single();
    deliveryId = (deliveryRow as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("audit_logs").delete().eq("company_id", companyId);
    await supabase.from("deliveries").delete().eq("company_id", companyId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("salesman_daily_sessions").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("id", customerId);
    await supabase.from("user_roles").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("id", salesAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
  }, 30000);

  it("21. Tutup Hari ditolak selama delivery masih non-terminal (blocked_open_deliveries)", async () => {
    const { data } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: null,
    });
    const row = (data ?? [])[0] as { result_outcome: string };
    expect(row.result_outcome).toBe("blocked_open_deliveries");

    const { data: sessionRow } = await supabase
      .from("salesman_daily_sessions")
      .select("status")
      .eq("id", sessionId)
      .single();
    expect((sessionRow as { status: string }).status).toBe("ACTIVE");
  });

  it("22. Setelah delivery finalisasi (verified) -> Tutup Hari berhasil", async () => {
    await supabase.from("deliveries").update({ status: "verified" }).eq("id", deliveryId);

    const { data } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: { callActual: 0 },
    });
    const row = (data ?? [])[0] as { result_outcome: string };
    expect(row.result_outcome).toBe("closed");

    const { data: sessionRow } = await supabase
      .from("salesman_daily_sessions")
      .select("status, close_summary")
      .eq("id", sessionId)
      .single();
    expect((sessionRow as { status: string }).status).toBe("CLOSED");
  });
});

describeIfDb("close_daily_session blocker -- active visit (Blocker 1, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-visit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let salesAuthId = "";
  let otherSalesAuthId = "";
  let ownerAuthId = "";
  let managerAuthId = "";
  let identityId = "";
  let otherIdentityId = "";
  let sessionId = "";
  const businessDate = "2026-08-06";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: managerRole } = await supabase.from("roles").select("id").eq("name", "manager").single();
    const salesRoleId = (salesRole as { id: string }).id;
    const ownerRoleId = (ownerRole as { id: string }).id;
    const managerRoleId = (managerRole as { id: string }).id;

    const makeAuthUser = async (label: string) => {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `${runTag}-${label}@verify.test`,
        password: randomUUID(),
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`gagal buat auth user ${label}: ${error?.message}`);
      return data.user.id;
    };
    salesAuthId = await makeAuthUser("sales");
    otherSalesAuthId = await makeAuthUser("sales2");
    ownerAuthId = await makeAuthUser("owner");
    managerAuthId = await makeAuthUser("manager");

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify Visit Blocker Co ${runTag}`, slug: `verify-visit-blocker-${runTag}` },
      { id: otherCompanyId, name: `Verify Visit Blocker Other Co ${runTag}`, slug: `verify-visit-blocker-other-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: otherSalesAuthId, company_id: companyId, email: `${runTag}-sales2@verify.test`, full_name: "Sales2 Verify", is_active: true },
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: managerAuthId, company_id: companyId, email: `${runTag}-manager@verify.test`, full_name: "Manager Verify", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: otherSalesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: managerAuthId, company_id: companyId, role_id: managerRoleId },
    ]);

    const { data: identityRow } = await supabase
      .from("telegram_identities")
      .insert({ company_id: companyId, user_id: salesAuthId, telegram_chat_id: 900000001, telegram_user_id: 900000001, is_active: true })
      .select("id")
      .single();
    identityId = (identityRow as { id: string }).id;

    const { data: otherIdentityRow } = await supabase
      .from("telegram_identities")
      .insert({ company_id: companyId, user_id: otherSalesAuthId, telegram_chat_id: 900000002, telegram_user_id: 900000002, is_active: true })
      .select("id")
      .single();
    otherIdentityId = (otherIdentityRow as { id: string }).id;

    const { data: startData } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: businessDate,
      p_idempotency_key: `${runTag}-start`,
    });
    sessionId = ((startData ?? [])[0] as { result_session_id: string }).result_session_id;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("audit_logs").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("telegram_menu_conversation_state").delete().in("telegram_identity_id", [identityId, otherIdentityId]);
    await supabase.from("telegram_identities").delete().in("id", [identityId, otherIdentityId]);
    await supabase.from("salesman_daily_sessions").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("users").delete().in("id", [salesAuthId, otherSalesAuthId, ownerAuthId, managerAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, otherCompanyId]);
    for (const id of [salesAuthId, otherSalesAuthId, ownerAuthId, managerAuthId]) {
      if (id) await supabase.auth.admin.deleteUser(id);
    }
  }, 30000);

  it("visit_store_select aktif -> close ditolak (blocked_open_visits)", async () => {
    await supabase
      .from("telegram_menu_conversation_state")
      .upsert({ telegram_identity_id: identityId, company_id: companyId, awaiting: "visit_store_select", draft_state: {} });

    const { data } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: null,
    });
    expect(((data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("blocked_open_visits");
  });

  it("visit_outcome_notes aktif juga memblokir (semua 4 sub-state visit)", async () => {
    await supabase
      .from("telegram_menu_conversation_state")
      .upsert({ telegram_identity_id: identityId, company_id: companyId, awaiting: "visit_outcome_notes", draft_state: {} });

    const { data } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: null,
    });
    expect(((data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("blocked_open_visits");
  });

  it("visit identity SALESMAN LAIN yang aktif tidak ikut memblokir (tenant/salesman isolation)", async () => {
    await supabase
      .from("telegram_menu_conversation_state")
      .upsert({ telegram_identity_id: identityId, company_id: companyId, awaiting: "none", draft_state: {} });
    await supabase
      .from("telegram_menu_conversation_state")
      .upsert({ telegram_identity_id: otherIdentityId, company_id: companyId, awaiting: "visit_pic_select", draft_state: {} });

    const { data } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: { note: "visit lain tidak menghalangi" },
    });
    expect(((data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("closed");
  });

  it("Closed-day invariant: Mulai Hari/session baru tidak otomatis ACTIVE lagi setelah closed", async () => {
    const { data: sessionRow } = await supabase
      .from("salesman_daily_sessions")
      .select("status")
      .eq("id", sessionId)
      .single();
    expect((sessionRow as { status: string }).status).toBe("CLOSED");
  });

  it("reopen: sales tidak boleh, owner/manager boleh, wajib reason, tercatat di audit_logs", async () => {
    const byOwnerNoReason = await supabase.rpc("reopen_daily_session", {
      p_company_id: companyId,
      p_actor_id: ownerAuthId,
      p_session_id: sessionId,
      p_reason: "x",
    });
    expect(((byOwnerNoReason.data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("reason_required");

    const bySales = await supabase.rpc("reopen_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_reason: "salesman coba buka sendiri",
    });
    expect(((bySales.data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("forbidden");

    const byManager = await supabase.rpc("reopen_daily_session", {
      p_company_id: companyId,
      p_actor_id: managerAuthId,
      p_session_id: sessionId,
      p_reason: "koreksi manager, salah tutup lebih awal",
    });
    expect(((byManager.data ?? [])[0] as { result_outcome: string }).result_outcome).toBe("reopened");

    const { data: sessionRow } = await supabase
      .from("salesman_daily_sessions")
      .select("status")
      .eq("id", sessionId)
      .single();
    expect((sessionRow as { status: string }).status).toBe("ACTIVE");

    const { data: auditRows } = await supabase
      .from("audit_logs")
      .select("action, user_id, new_data")
      .eq("company_id", companyId)
      .eq("action", "daily_session.reopened")
      .eq("entity_id", sessionId);
    expect(auditRows ?? []).toHaveLength(1);
    expect((auditRows as { user_id: string }[])[0]!.user_id).toBe(managerAuthId);
  });
});
