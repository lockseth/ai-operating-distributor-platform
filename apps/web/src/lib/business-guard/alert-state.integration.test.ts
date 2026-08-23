// =============================================================================
// DB-backed integration test -- Business Guard Alert State (Gate P4.20).
//
// Business Guard AI sebelumnya 100% SELECT+JS murni (5 fitur lain cukup unit
// test) -- tabel business_guard_alert_state adalah jalur TULIS PERTAMA di
// modul ini. Yang perlu dibuktikan ke Postgres sungguhan (bukan mock):
// idempotency UPSERT nyata, pipeline penuh evaluateAndPersistAlertState
// (keputusan + upsert + closure entitas hilang) lewat beberapa hari
// berturut, RLS (SELECT owner/manager/super_admin saja, tidak ada jalur
// tulis untuk siapa pun), dan constraint unique 3 kolom (bukan cuma
// company+entity).
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia
// ATAU URL bukan loopback -- pola identik outbox.integration.test.ts /
// cross-tenant-and-rls.integration.test.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { evaluateAndPersistAlertState, type AlertEvaluationInput } from "./alert-state";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
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

describeIfDb("Business Guard Alert State Integration -- idempotency/pipeline/RLS (Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  let ownerAAuthId = "";
  let salesAAuthId = "";
  let ownerBAuthId = "";
  const password = randomUUID();
  const createdCompanyIds = [companyAId, companyBId];

  async function signIn(email: string): Promise<SupabaseClient> {
    const scoped = createClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`sign in gagal untuk ${email}: ${error.message}`);
    return scoped;
  }

  beforeAll(async () => {
    service = createClient(env!.url, env!.serviceRoleKey);

    const { data: roles } = await service.from("roles").select("id, name").in("name", ["owner", "sales"]);
    const ownerRoleId = (roles as { id: string; name: string }[]).find((r) => r.name === "owner")!.id;
    const salesRoleId = (roles as { id: string; name: string }[]).find((r) => r.name === "sales")!.id;

    const emails = {
      ownerA: `${runTag}-owner-a@verify.test`,
      salesA: `${runTag}-sales-a@verify.test`,
      ownerB: `${runTag}-owner-b@verify.test`,
    };

    const { data: ownerAAuth, error: ownerAErr } = await service.auth.admin.createUser({ email: emails.ownerA, password, email_confirm: true });
    if (ownerAErr || !ownerAAuth.user) throw new Error(`gagal buat owner A: ${ownerAErr?.message}`);
    ownerAAuthId = ownerAAuth.user.id;

    const { data: salesAAuth, error: salesAErr } = await service.auth.admin.createUser({ email: emails.salesA, password, email_confirm: true });
    if (salesAErr || !salesAAuth.user) throw new Error(`gagal buat sales A: ${salesAErr?.message}`);
    salesAAuthId = salesAAuth.user.id;

    const { data: ownerBAuth, error: ownerBErr } = await service.auth.admin.createUser({ email: emails.ownerB, password, email_confirm: true });
    if (ownerBErr || !ownerBAuth.user) throw new Error(`gagal buat owner B: ${ownerBErr?.message}`);
    ownerBAuthId = ownerBAuth.user.id;

    await service.from("companies").insert([
      { id: companyAId, name: `Verify Co A ${runTag}`, slug: `verify-p420-a-${runTag}` },
      { id: companyBId, name: `Verify Co B ${runTag}`, slug: `verify-p420-b-${runTag}` },
    ]);
    await service.from("users").insert([
      { id: ownerAAuthId, company_id: companyAId, email: emails.ownerA, full_name: "Owner A", is_active: true },
      { id: salesAAuthId, company_id: companyAId, email: emails.salesA, full_name: "Sales A", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: emails.ownerB, full_name: "Owner B", is_active: true },
    ]);
    await service.from("user_roles").insert([
      { user_id: ownerAAuthId, company_id: companyAId, role_id: ownerRoleId },
      { user_id: salesAAuthId, company_id: companyAId, role_id: salesRoleId },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: ownerRoleId },
    ]);
  });

  afterAll(async () => {
    if (!service) return;
    await service.from("business_guard_alert_state").delete().in("company_id", createdCompanyIds);
    await service.from("user_roles").delete().in("company_id", createdCompanyIds);
    await service.from("users").delete().in("id", [ownerAAuthId, salesAAuthId, ownerBAuthId].filter(Boolean));
    await service.from("companies").delete().in("id", createdCompanyIds);
    if (ownerAAuthId) await service.auth.admin.deleteUser(ownerAAuthId);
    if (salesAAuthId) await service.auth.admin.deleteUser(salesAAuthId);
    if (ownerBAuthId) await service.auth.admin.deleteUser(ownerBAuthId);
  }, 30000);

  it("1. dipanggil 2x berturut dengan input HIGH sama -> run kedua tidak notify (idempotency UPSERT nyata)", async () => {
    const entityKey = `entity-${runTag}-1`;
    const input: AlertEvaluationInput<{ note: string }>[] = [{ entityKey, riskLevel: "HIGH", payload: { note: "x" } }];

    const first = await evaluateAndPersistAlertState(service, companyAId, "discount_anomaly", input, ["HIGH"]);
    expect(first[0]!.shouldNotify).toBe(true);

    const second = await evaluateAndPersistAlertState(service, companyAId, "discount_anomaly", input, ["HIGH"]);
    expect(second[0]!.shouldNotify).toBe(false);

    const { data: rows } = await service
      .from("business_guard_alert_state")
      .select("id")
      .eq("company_id", companyAId)
      .eq("alert_type", "discount_anomaly")
      .eq("entity_key", entityKey);
    expect(rows ?? []).toHaveLength(1); // UPSERT, bukan INSERT berulang
  });

  it("2. sekuens multi-hari lewat fungsi asli: HIGH(notify)->HIGH(diam)->NONE(diam,reset)->HIGH(notify lagi)", async () => {
    const entityKey = `entity-${runTag}-2`;
    const day1 = await evaluateAndPersistAlertState(
      service, companyAId, "collection_risk",
      [{ entityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );
    expect(day1[0]!.shouldNotify).toBe(true);

    const day2 = await evaluateAndPersistAlertState(
      service, companyAId, "collection_risk",
      [{ entityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );
    expect(day2[0]!.shouldNotify).toBe(false);

    // Hari ke-3: customer lunas -> hilang total dari laporan (closure entitas hilang).
    const day3 = await evaluateAndPersistAlertState(
      service, companyAId, "collection_risk",
      [], ["HIGH"],
    );
    expect(day3).toHaveLength(0); // tidak ada payload untuk entitas yang di-closure

    const { data: rowAfterClosure } = await service
      .from("business_guard_alert_state")
      .select("last_risk_level, last_notified_risk_level")
      .eq("company_id", companyAId).eq("alert_type", "collection_risk").eq("entity_key", entityKey)
      .single();
    expect(rowAfterClosure?.last_risk_level).toBe("NONE");
    expect(rowAfterClosure?.last_notified_risk_level).toBeNull();

    // Hari ke-4: nunggak lagi sampai HIGH -> harus notify lagi (bukan dianggap "sudah pernah").
    const day4 = await evaluateAndPersistAlertState(
      service, companyAId, "collection_risk",
      [{ entityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );
    expect(day4[0]!.shouldNotify).toBe(true);
  });

  it("3. RLS: sales (role salah, company benar) tidak bisa baca; owner company lain (company salah) tidak bisa baca; INSERT/UPDATE/DELETE dari authenticated ditolak", async () => {
    const entityKey = `entity-${runTag}-3`;
    await evaluateAndPersistAlertState(
      service, companyAId, "behavior_change",
      [{ entityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );

    const asOwnerA = await signIn(`${runTag}-owner-a@verify.test`);
    const { data: ownerARows } = await asOwnerA
      .from("business_guard_alert_state")
      .select("id").eq("company_id", companyAId).eq("entity_key", entityKey);
    expect(ownerARows ?? []).toHaveLength(1); // owner company sendiri: BISA baca

    const asSalesA = await signIn(`${runTag}-sales-a@verify.test`);
    const { data: salesARows } = await asSalesA
      .from("business_guard_alert_state")
      .select("id").eq("company_id", companyAId).eq("entity_key", entityKey);
    expect(salesARows ?? []).toHaveLength(0); // role salah (sales, bukan owner/manager/super_admin): TIDAK bisa baca

    const asOwnerB = await signIn(`${runTag}-owner-b@verify.test`);
    const { data: ownerBRows } = await asOwnerB
      .from("business_guard_alert_state")
      .select("id").eq("company_id", companyAId).eq("entity_key", entityKey);
    expect(ownerBRows ?? []).toHaveLength(0); // company salah (cross-tenant): TIDAK bisa baca

    const { error: insertErr } = await asOwnerA.from("business_guard_alert_state").insert({
      company_id: companyAId, alert_type: "behavior_change", entity_key: `entity-${runTag}-blocked`, last_risk_level: "HIGH",
    });
    expect(insertErr).not.toBeNull(); // tidak ada policy INSERT untuk siapa pun, termasuk owner

    const { error: updateErr } = await asOwnerA
      .from("business_guard_alert_state")
      .update({ last_risk_level: "NONE" })
      .eq("company_id", companyAId).eq("entity_key", entityKey);
    expect(updateErr).not.toBeNull();

    const { error: deleteErr } = await asOwnerA
      .from("business_guard_alert_state")
      .delete()
      .eq("company_id", companyAId).eq("entity_key", entityKey);
    expect(deleteErr).not.toBeNull();
  });

  it("4. 2 alert_type beda dengan entity_key SAMA di company sama -> tidak tabrakan (unique constraint 3 kolom)", async () => {
    const sharedEntityKey = `entity-${runTag}-shared`;

    await evaluateAndPersistAlertState(
      service, companyAId, "discount_anomaly",
      [{ entityKey: sharedEntityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );
    await evaluateAndPersistAlertState(
      service, companyAId, "transaction_risk",
      [{ entityKey: sharedEntityKey, riskLevel: "HIGH", payload: {} }], ["HIGH"],
    );

    const { data: rows } = await service
      .from("business_guard_alert_state")
      .select("alert_type")
      .eq("company_id", companyAId)
      .eq("entity_key", sharedEntityKey);
    expect((rows ?? []).map((r) => r.alert_type).sort()).toEqual(["discount_anomaly", "transaction_risk"]);
  });
});
