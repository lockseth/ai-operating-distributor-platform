// =============================================================================
// DB-backed integration test -- Salesman Daily Session.
//
// Membuktikan hal yang tidak bisa dibuktikan InMemory: RLS cross-tenant,
// UNIQUE (company_id, salesman_id, business_date) di level DB, dan trigger
// append-only (trg_sds_fact_immutable/trg_sds_forbid_delete) benar-benar
// menyala di Postgres nyata. Skip graceful jika kredensial Supabase lokal
// tidak tersedia atau URL bukan loopback -- pola sama dengan
// sales-kpi/achievement.integration.test.ts.
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

describeIfDb("Salesman Daily Session (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let otherCompanyOwnerId = "";
  const businessDate = "2026-07-18";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const salesRoleId = (salesRole as { id: string }).id;

    const { data: ownerAuth, error: ownerErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner@verify.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (ownerErr || !ownerAuth.user) throw new Error(`gagal buat auth user owner: ${ownerErr?.message}`);
    ownerAuthId = ownerAuth.user.id;

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@verify.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user sales: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;

    const { data: otherOwnerAuth, error: otherOwnerErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-other-owner@verify.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (otherOwnerErr || !otherOwnerAuth.user) {
      throw new Error(`gagal buat auth user other-owner: ${otherOwnerErr?.message}`);
    }
    otherCompanyOwnerId = otherOwnerAuth.user.id;

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify Daily Session Co ${runTag}`, slug: `verify-dsession-${runTag}` },
      { id: otherCompanyId, name: `Verify Other Co ${runTag}`, slug: `verify-dsession-other-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Sales Verify", is_active: true },
      { id: otherCompanyOwnerId, company_id: otherCompanyId, email: `${runTag}-other-owner@verify.test`, full_name: "Other Owner Verify", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: otherCompanyOwnerId, company_id: otherCompanyId, role_id: ownerRoleId },
    ]);
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("audit_logs").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("salesman_daily_sessions").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, otherCompanyOwnerId]);
    await supabase.from("companies").delete().in("id", [companyId, otherCompanyId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    if (otherCompanyOwnerId) await supabase.auth.admin.deleteUser(otherCompanyOwnerId);
  }, 30000);

  it("6/7. Mulai Hari membuat satu session, retry idempoten (UNIQUE company+salesman+business_date)", async () => {
    const key = `${runTag}-start`;
    const { data: firstRow } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: businessDate,
      p_idempotency_key: key,
    });
    const first = (firstRow ?? [])[0] as { result_outcome: string; result_session_id: string };
    expect(first.result_outcome).toBe("started");
    expect(first.result_session_id).toBeTruthy();

    const { data: secondRow } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: businessDate,
      p_idempotency_key: `${runTag}-start-different-key`,
    });
    const second = (secondRow ?? [])[0] as { result_outcome: string; result_session_id: string };
    expect(second.result_outcome).toBe("already_started");
    expect(second.result_session_id).toBe(first.result_session_id);

    const { count } = await supabase
      .from("salesman_daily_sessions")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("salesman_id", salesAuthId)
      .eq("business_date", businessDate);
    expect(count).toBe(1);
  });

  it("18. Cross-tenant: actor company lain tidak bisa start session salesman company ini", async () => {
    const { data } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: otherCompanyOwnerId,
      p_salesman_id: salesAuthId,
      p_business_date: "2026-07-19",
      p_idempotency_key: `${runTag}-cross-tenant`,
    });
    const row = (data ?? [])[0] as { result_outcome: string };
    expect(row.result_outcome).toBe("forbidden");
  });

  it("append-only: UPDATE kolom fakta ditolak trigger, DELETE ditolak trigger", async () => {
    const { data } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: "2026-07-20",
      p_idempotency_key: `${runTag}-immutable`,
    });
    const sessionId = ((data ?? [])[0] as { result_session_id: string }).result_session_id;

    const { error: updateError } = await supabase
      .from("salesman_daily_sessions")
      .update({ business_date: "2026-07-21" })
      .eq("id", sessionId);
    expect(updateError).toBeTruthy();

    const { error: deleteError } = await supabase
      .from("salesman_daily_sessions")
      .delete()
      .eq("id", sessionId);
    expect(deleteError).toBeTruthy();
  });

  it("21/22/23. Tutup Hari: berhasil menutup, idempotent, dan bisa dibuka kembali manager (reopen)", async () => {
    const { data: startData } = await supabase.rpc("start_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_salesman_id: salesAuthId,
      p_business_date: "2026-07-22",
      p_idempotency_key: `${runTag}-close-flow`,
    });
    const sessionId = ((startData ?? [])[0] as { result_session_id: string }).result_session_id;

    const { data: closeData1 } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: { callCount: 3 },
    });
    expect(((closeData1 ?? [])[0] as { result_outcome: string }).result_outcome).toBe("closed");

    const { data: closeData2 } = await supabase.rpc("close_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_close_summary: null,
    });
    expect(((closeData2 ?? [])[0] as { result_outcome: string }).result_outcome).toBe("already_closed");

    const { data: reopenBySales } = await supabase.rpc("reopen_daily_session", {
      p_company_id: companyId,
      p_actor_id: salesAuthId,
      p_session_id: sessionId,
      p_reason: "salesman coba buka lagi",
    });
    expect(((reopenBySales ?? [])[0] as { result_outcome: string }).result_outcome).toBe("forbidden");

    const { data: reopenByOwner } = await supabase.rpc("reopen_daily_session", {
      p_company_id: companyId,
      p_actor_id: ownerAuthId,
      p_session_id: sessionId,
      p_reason: "koreksi owner, salah tutup lebih awal",
    });
    expect(((reopenByOwner ?? [])[0] as { result_outcome: string }).result_outcome).toBe("reopened");

    const { data: sessionRow } = await supabase
      .from("salesman_daily_sessions")
      .select("status, close_summary")
      .eq("id", sessionId)
      .single();
    expect((sessionRow as { status: string }).status).toBe("ACTIVE");
    expect((sessionRow as { close_summary: unknown }).close_summary).toBeNull();
  });
});
