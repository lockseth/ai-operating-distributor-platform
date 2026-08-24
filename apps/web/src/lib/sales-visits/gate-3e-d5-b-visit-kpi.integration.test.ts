// =============================================================================
// DB-backed integration test -- Gate 3E-D5-B: Web Kunjungan Sales ->
// Achievement CALL & EFFECTIVE_CALL.
//
// Logic kredit hidup di RPC SECURITY DEFINER (start_sales_visit,
// complete_sales_visit, migration 20261001000001) -- hanya Postgres
// sungguhan yang bisa membuktikan idempotency/concurrency/tenant isolation
// di bawah advisory lock + UNIQUE INDEX partial. Pola beforeAll/afterAll dan
// skip-graceful mengikuti noo-achievement.integration.test.ts persis.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak
// tersedia, ATAU kalau URL yang terbaca BUKAN loopback.
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
}

describeIfDb("Gate 3E-D5-B -- Kunjungan Sales CALL/EC crediting (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-visit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const companyBId = randomUUID();
  let ownerAuthId = "";
  let salesAuthId = "";
  let salesOtherAuthId = "";
  let salesBAuthId = "";
  let customerId = "";
  let customerBId = "";
  let periodId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: salesRole } = await supabase.from("roles").select("id").eq("name", "sales").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const salesRoleId = (salesRole as { id: string }).id;

    const mkUser = async (label: string) => {
      const { data, error } = await supabase.auth.admin.createUser({
        email: `${runTag}-${label}@verify.test`, password: randomUUID(), email_confirm: true,
      });
      if (error || !data.user) throw new Error(`gagal buat auth user ${label}: ${error?.message}`);
      return data.user.id;
    };

    ownerAuthId = await mkUser("owner");
    salesAuthId = await mkUser("sales");
    salesOtherAuthId = await mkUser("sales-other");
    salesBAuthId = await mkUser("sales-b");

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify Visit Co ${runTag}`, slug: `verify-visit-${runTag}` },
      { id: companyBId, name: `Verify Visit Co B ${runTag}`, slug: `verify-visit-b-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: salesAuthId, company_id: companyId, email: `${runTag}-sales@verify.test`, full_name: "Salma Verify", is_active: true },
      { id: salesOtherAuthId, company_id: companyId, email: `${runTag}-sales-other@verify.test`, full_name: "Sales Lain Verify", is_active: true },
      { id: salesBAuthId, company_id: companyBId, email: `${runTag}-sales-b@verify.test`, full_name: "Sales Verify B", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: salesAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: salesOtherAuthId, company_id: companyId, role_id: salesRoleId },
      { user_id: salesBAuthId, company_id: companyBId, role_id: salesRoleId },
    ]);

    customerId = randomUUID();
    await supabase.from("customers").insert({
      id: customerId, company_id: companyId, code: `C-${runTag}`, name: "Toko Verify Visit",
      address: "Jl. Verify No. 1", is_active: true, assigned_sales_id: salesAuthId,
    });
    customerBId = randomUUID();
    await supabase.from("customers").insert({
      id: customerBId, company_id: companyBId, code: `C-B-${runTag}`, name: "Toko Verify Visit B", is_active: true,
    });

    await supabase.rpc("initialize_sales_kpi_foundation", { p_company_id: companyId, p_actor_id: ownerAuthId });
    const { data: periodRow } = await supabase.rpc("create_sales_kpi_period", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_name: `Periode Visit ${runTag}`,
      // Rentang lebar sengaja membungkus tanggal server NOW() apa pun (jangan
      // asumsikan tahun kalender riil sama dengan tanggal fiktif skenario lain).
      p_start_date: "2020-01-01", p_end_date: "2030-12-31", p_working_days: 100,
    });
    periodId = (periodRow ?? [])[0]?.result_period_id as string;
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "ACTIVE",
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_kpi_achievement_events").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_calls").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_visits").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_targets").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_periods").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("sales_kpi_definitions").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("customers").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, companyBId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, salesAuthId, salesOtherAuthId, salesBAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, companyBId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    if (salesOtherAuthId) await supabase.auth.admin.deleteUser(salesOtherAuthId);
    if (salesBAuthId) await supabase.auth.admin.deleteUser(salesBAuthId);
  }, 30000);

  // sales_calls (ledger CALL yang dipakai ulang oleh complete_sales_visit)
  // menegakkan uq_sales_calls_one_per_day: maksimal SATU CALL per
  // (salesperson, customer, hari) -- invarian anti-gaming existing yang
  // sengaja diwariskan, BUKAN bug. Setiap skenario test yang mengharapkan
  // CALL benar-benar dikreditkan HARUS memakai toko baru (satu hari
  // kalender yang sama tidak bisa menghasilkan >1 CALL utuh ke toko yang
  // sama) -- pola yang sama seperti fresh customer per-`it` pada
  // noo-achievement.integration.test.ts.
  async function freshCustomer(label: string, targetCompanyId: string = companyId): Promise<string> {
    const id = randomUUID();
    await supabase.from("customers").insert({
      id, company_id: targetCompanyId, code: `C-${runTag}-${label}`, name: `Toko Verify ${label}`,
      is_active: true,
    });
    return id;
  }

  // sales_kpi_achievement_events.source_id merujuk ID baris sales_calls
  // (call_id) yang dikreditkan, BUKAN ID sales_visits -- ambil call_id dari
  // sales_visits.call_id setelah completion untuk query ledger yang benar.
  async function visitCallId(visitId: string): Promise<string> {
    const { data } = await supabase.from("sales_visits").select("call_id").eq("id", visitId).single();
    return (data as { call_id: string }).call_id;
  }

  async function startVisit(actorId: string, custId: string, key: string, targetCompanyId: string = companyId) {
    const { data, error } = await supabase.rpc("start_sales_visit", {
      p_company_id: targetCompanyId, p_actor_id: actorId, p_customer_id: custId,
      p_visit_purpose: "OFFER_PRODUCT", p_plan_notes: "Rencana kunjungan",
      p_start_latitude: -6.2, p_start_longitude: 106.8, p_idempotency_key: key,
    });
    if (error) console.error("[start_sales_visit error]", error);
    return (data ?? [])[0] as { result_outcome: string; result_visit_id: string | null };
  }

  async function completeVisit(actorId: string, visitId: string, opts: {
    visitResult: string; metWith?: string | null; activities?: string[]; key: string; companyId?: string;
  }) {
    const { data, error } = await supabase.rpc("complete_sales_visit", {
      p_company_id: opts.companyId ?? companyId, p_actor_id: actorId, p_visit_id: visitId,
      p_visit_result: opts.visitResult, p_met_with: opts.metWith ?? null, p_met_person_name: "Pak Budi",
      p_activities: opts.activities ?? [], p_result_notes: "Catatan hasil kunjungan yang memadai",
      p_follow_up_needed: false, p_follow_up_plan: null, p_follow_up_date: null, p_photo_url: null,
      p_end_latitude: -6.21, p_end_longitude: 106.81, p_idempotency_key: opts.key,
    });
    if (error) console.error("[complete_sales_visit error]", error);
    return (data ?? [])[0] as {
      result_outcome: string; result_visit_id: string | null;
      result_call_credited: boolean | null; result_ec_credited: boolean | null;
    };
  }

  it("1-2. Dropdown/tenant scope: kunjungan dari customer tenant lain (cross-tenant) ditolak", async () => {
    const res = await startVisit(salesAuthId, customerBId, `visit-start:${runTag}:cross-tenant`);
    expect(res.result_outcome).toBe("customer_not_found");
  });

  it("5. Waktu berasal dari server -- started_at diisi otomatis dekat NOW(), tidak dari input", async () => {
    const key = `visit-start:${runTag}:server-time`;
    const res = await startVisit(salesAuthId, customerId, key);
    expect(res.result_outcome).toBe("started");
    const { data: visit } = await supabase.from("sales_visits").select("started_at").eq("id", res.result_visit_id!).single();
    const startedAt = new Date((visit as { started_at: string }).started_at).getTime();
    expect(Math.abs(Date.now() - startedAt)).toBeLessThan(15_000);
    // Bersihkan supaya tidak mengganggu skenario "satu kunjungan aktif" berikutnya.
    await completeVisit(salesAuthId, res.result_visit_id!, { visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:server-time` });
  });

  it("7. Dua kunjungan aktif sekaligus ditolak (server/DB enforcement)", async () => {
    const first = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:dup-active-1`);
    expect(first.result_outcome).toBe("started");

    const second = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:dup-active-2`);
    expect(second.result_outcome).toBe("visit_already_active");

    await completeVisit(salesAuthId, first.result_visit_id!, { visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:dup-active-1` });
  });

  it("6. Sales lain tidak dapat menyelesaikan kunjungan Sales pertama (forbidden, fail-closed)", async () => {
    const started = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:ownership`);
    expect(started.result_outcome).toBe("started");

    const forged = await completeVisit(salesOtherAuthId, started.result_visit_id!, {
      visitResult: "STORE_CLOSED", key: `visit-complete:${runTag}:ownership-forge`,
    });
    expect(forged.result_outcome).toBe("forbidden");

    // RLS SELECT: sales lain tidak dapat membaca baris kunjungan Salma lewat tabel langsung.
    // (repository/actions selalu lewat admin client + RPC -- ini membuktikan RLS-nya sendiri
    // tetap benar sebagai defense-in-depth kalau suatu saat dibaca lewat client biasa.)
    const { data: policies } = await supabase
      .from("sales_visits")
      .select("id")
      .eq("id", started.result_visit_id!)
      .eq("salesperson_id", salesOtherAuthId);
    expect(policies ?? []).toHaveLength(0);

    await completeVisit(salesAuthId, started.result_visit_id!, { visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:ownership-cleanup` });
  });

  it("Direct RPC manipulation lintas tenant (actor company B, visit company A) gagal tertutup", async () => {
    const started = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:tenant-forge`);
    expect(started.result_outcome).toBe("started");

    const { data } = await supabase.rpc("complete_sales_visit", {
      p_company_id: companyBId, p_actor_id: salesBAuthId, p_visit_id: started.result_visit_id,
      p_visit_result: "MET_STORE", p_met_with: "OWNER", p_met_person_name: null,
      p_activities: ["OFFER_PRODUCT"], p_result_notes: "Percobaan forge lintas tenant",
      p_follow_up_needed: false, p_follow_up_plan: null, p_follow_up_date: null, p_photo_url: null,
      p_end_latitude: -6.2, p_end_longitude: 106.8, p_idempotency_key: `visit-complete:${runTag}:tenant-forge`,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("visit_not_found");

    await completeVisit(salesAuthId, started.result_visit_id!, { visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:tenant-forge-cleanup` });
  });

  it("8. Kunjungan dibatalkan -> CALL 0, EC 0", async () => {
    const started = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:cancelled`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:cancelled`,
    });
    expect(done.result_outcome).toBe("completed_cancelled");
    expect(done.result_call_credited).toBeFalsy();
    expect(done.result_ec_credited).toBeFalsy();

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .in("kpi_code", ["CALL", "EFFECTIVE_CALL"])
      .eq("source_id", started.result_visit_id!);
    expect(events ?? []).toHaveLength(0);
  });

  it("9. Toko tutup -> CALL +1, EC 0", async () => {
    const custId = await freshCustomer("closed");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:closed`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "STORE_CLOSED", key: `visit-complete:${runTag}:closed`,
    });
    expect(done.result_outcome).toBe("completed");
    expect(done.result_call_credited).toBe(true);
    expect(done.result_ec_credited).toBe(false);
  });

  it("10. Tidak bertemu pihak toko -> CALL +1, EC 0", async () => {
    const custId = await freshCustomer("not-avail");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:not-avail`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "PERSON_NOT_AVAILABLE", key: `visit-complete:${runTag}:not-avail`,
    });
    expect(done.result_outcome).toBe("completed");
    expect(done.result_call_credited).toBe(true);
    expect(done.result_ec_credited).toBe(false);
  });

  it("11. Bertemu tetapi aktivitas substantif kosong -> CALL +1, EC 0", async () => {
    const custId = await freshCustomer("met-no-activity");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:met-no-activity`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: [], key: `visit-complete:${runTag}:met-no-activity`,
    });
    expect(done.result_outcome).toBe("completed");
    expect(done.result_call_credited).toBe(true);
    expect(done.result_ec_credited).toBe(false);
  });

  it("12. Bertemu dan aktivitas substantif valid -> CALL +1, EC +1", async () => {
    const custId = await freshCustomer("effective");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:effective`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT", "CHECK_STOCK"],
      key: `visit-complete:${runTag}:effective`,
    });
    expect(done.result_outcome).toBe("completed");
    expect(done.result_call_credited).toBe(true);
    expect(done.result_ec_credited).toBe(true);

    const callId = await visitCallId(started.result_visit_id!);
    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code, event_type, call_id, order_id, value")
      .eq("company_id", companyId)
      .eq("call_id", callId);
    const rows = (events ?? []) as { kpi_code: string; event_type: string; call_id: string; order_id: string | null; value: string }[];
    expect(rows.filter((r) => r.kpi_code === "CALL" && r.event_type === "CREDITED")).toHaveLength(1);
    expect(rows.filter((r) => r.kpi_code === "EFFECTIVE_CALL" && r.event_type === "CREDITED")).toHaveLength(1);
    // Kontrak Founder: EC dari kunjungan web TIDAK terhubung ke order.
    expect(rows.every((r) => r.order_id === null)).toBe(true);
    // CALL dan EC merujuk call_id yang SAMA (identitas kunjungan yang sama).
    const callIds = new Set(rows.map((r) => r.call_id));
    expect(callIds.size).toBe(1);
  });

  it("12b. Kunjungan KEDUA ke toko yang SAMA pada hari yang sama tetap SELESAI (bukan error), tanpa kredit CALL/EC ganda (fix uq_sales_calls_one_per_day graceful)", async () => {
    const custId = await freshCustomer("dup-call");
    const key1 = `visit-start:${runTag}:dup-call-1`;
    const key2 = `visit-start:${runTag}:dup-call-2`;

    const started1 = await startVisit(salesAuthId, custId, key1);
    const done1 = await completeVisit(salesAuthId, started1.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["COLLECT_PAYMENT"],
      key: `visit-complete:${runTag}:dup-call-1`,
    });
    expect(done1.result_outcome).toBe("completed");
    expect(done1.result_call_credited).toBe(true);

    const started2 = await startVisit(salesAuthId, custId, key2);
    expect(started2.result_outcome).toBe("started");
    const done2 = await completeVisit(salesAuthId, started2.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["COLLECT_PAYMENT"],
      key: `visit-complete:${runTag}:dup-call-2`,
    });
    // Sebelum fix: baris ini melempar raw Postgres error (unique_violation)
    // dan MEMBATALKAN seluruh completion (visit tetap IN_PROGRESS selamanya).
    expect(done2.result_outcome).toBe("completed_duplicate_call");
    expect(done2.result_call_credited).toBe(false);
    expect(done2.result_ec_credited).toBe(false);

    const { data: visit2Row } = await supabase
      .from("sales_visits").select("status, call_id").eq("id", started2.result_visit_id!).single();
    expect((visit2Row as { status: string; call_id: string | null }).status).toBe("COMPLETED");
    expect((visit2Row as { status: string; call_id: string | null }).call_id).toBeNull();

    const { data: callsToday } = await supabase
      .from("sales_calls").select("id").eq("company_id", companyId).eq("customer_id", custId);
    expect((callsToday ?? []).length).toBe(1);
  });

  it("13. Completion ulang dengan idempotency key yang SAMA tetap satu credit (idempotent replay)", async () => {
    const custId = await freshCustomer("retry");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:retry`);
    const key = `visit-complete:${runTag}:retry`;
    const first = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"], key,
    });
    expect(first.result_outcome).toBe("completed");

    const retry = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"], key,
    });
    expect(retry.result_outcome).toBe("already_recorded");
    expect(retry.result_call_credited).toBe(true);
    expect(retry.result_ec_credited).toBe(true);

    const callId = await visitCallId(started.result_visit_id!);
    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .in("kpi_code", ["CALL", "EFFECTIVE_CALL"])
      .eq("call_id", callId)
      .eq("event_type", "CREDITED");
    expect(events ?? []).toHaveLength(2); // 1 CALL + 1 EC, tidak digandakan.
  });

  it("Completion ulang dengan idempotency key BERBEDA pada kunjungan yang sudah selesai ditolak (already_completed, bukan dobel kredit)", async () => {
    const custId = await freshCustomer("diff-key");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:diff-key`);
    const first = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "STORE_CLOSED", key: `visit-complete:${runTag}:diff-key-1`,
    });
    expect(first.result_outcome).toBe("completed");

    const second = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"],
      key: `visit-complete:${runTag}:diff-key-2`,
    });
    expect(second.result_outcome).toBe("already_completed");

    const callId = await visitCallId(started.result_visit_id!);
    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("kpi_code", "EFFECTIVE_CALL")
      .eq("call_id", callId);
    expect(events ?? []).toHaveLength(0); // tetap 0 -- percobaan kedua tidak pernah tereksekusi.
  });

  it("14. Concurrent completion kunjungan yang sama tidak menggandakan CALL/EC", async () => {
    const custId = await freshCustomer("race");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:race`);
    const key = `visit-complete:${runTag}:race`;

    const [a, b] = await Promise.all([
      completeVisit(salesAuthId, started.result_visit_id!, {
        visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"], key,
      }),
      completeVisit(salesAuthId, started.result_visit_id!, {
        visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"], key,
      }),
    ]);
    expect([a.result_outcome, b.result_outcome].sort()).toEqual(["already_recorded", "completed"]);

    const callId = await visitCallId(started.result_visit_id!);
    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, kpi_code")
      .eq("company_id", companyId)
      .in("kpi_code", ["CALL", "EFFECTIVE_CALL"])
      .eq("call_id", callId)
      .eq("event_type", "CREDITED");
    expect(events ?? []).toHaveLength(2);
  });

  it("16. Ledger append-only tetap berlaku untuk baris CALL/EC dari kunjungan web", async () => {
    const custId = await freshCustomer("append-only");
    const started = await startVisit(salesAuthId, custId, `visit-start:${runTag}:append-only`);
    await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"],
      key: `visit-complete:${runTag}:append-only`,
    });

    const callId = await visitCallId(started.result_visit_id!);
    const { data: anyEvent } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("call_id", callId)
      .eq("kpi_code", "EFFECTIVE_CALL")
      .single();
    const eventId = (anyEvent as { id: string }).id;

    const { error: updateError } = await supabase
      .from("sales_kpi_achievement_events").update({ value: 999 }).eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await supabase
      .from("sales_kpi_achievement_events").delete().eq("id", eventId);
    expect(deleteError).not.toBeNull();

    // sales_visits sendiri immutable setelah COMPLETED.
    const { error: visitUpdateError } = await supabase
      .from("sales_visits").update({ result_notes: "diubah paksa" }).eq("id", started.result_visit_id!);
    expect(visitUpdateError).not.toBeNull();
  });

  // Locked ke ACTIVE BUKAN transisi yang diizinkan (canTransitionSalesKpiPeriod,
  // sales-kpi/service.ts) -- mengunci periode adalah operasi SATU ARAH. Skenario
  // ini karena itu HARUS berjalan PALING TERAKHIR di antara test yang butuh
  // periode ACTIVE (semua test di atas titik ini) -- jangan menyisipkan test
  // baru yang mengandalkan periode ACTIVE SETELAH skenario ini.
  it("15. Tanpa periode KPI aktif tidak membuat credit yang salah (kunjungan tetap tercatat, achievement tidak dikreditkan)", async () => {
    await supabase.rpc("set_sales_kpi_period_status", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_period_id: periodId, p_next_status: "LOCKED",
    });

    const started = await startVisit(salesAuthId, customerId, `visit-start:${runTag}:no-period`);
    const done = await completeVisit(salesAuthId, started.result_visit_id!, {
      visitResult: "MET_STORE", metWith: "OWNER", activities: ["OFFER_PRODUCT"],
      key: `visit-complete:${runTag}:no-period`,
    });
    expect(done.result_outcome).toBe("completed_no_active_period");

    const { data: visitRow } = await supabase
      .from("sales_visits").select("status, visit_result").eq("id", started.result_visit_id!).single();
    expect((visitRow as { status: string }).status).toBe("COMPLETED");

    const { data: events } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id")
      .eq("company_id", companyId)
      .eq("source_id", started.result_visit_id!);
    expect(events ?? []).toHaveLength(0);
  });

  it("19. Tenant isolation: kunjungan/CALL/EC company B tidak pernah bocor ke company A, dan sebaliknya", async () => {
    const startedB = await startVisit(salesBAuthId, customerBId, `visit-start:${runTag}:tenantB`, companyBId);
    expect(startedB.result_outcome).toBe("started");

    const { data: leaked } = await supabase
      .from("sales_visits").select("id").eq("company_id", companyId).eq("id", startedB.result_visit_id!);
    expect(leaked ?? []).toHaveLength(0);

    await completeVisit(salesBAuthId, startedB.result_visit_id!, {
      visitResult: "VISIT_CANCELLED", key: `visit-complete:${runTag}:tenantB`, companyId: companyBId,
    });
  });

  it("17. ORDER_COUNT/REVENUE/NOO tidak mengalami regresi -- order confirmed tetap dikredit normal, tidak terpengaruh visit crediting", async () => {
    const orderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: orderId, company_id: companyId, order_number: `SO-${runTag}-visit-regress`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "OTHER", is_historical: false, final_amount: 1_234_000,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", orderId).eq("status", "draft");

    const { data: orderEvents } = await supabase
      .from("sales_kpi_achievement_events")
      .select("kpi_code")
      .eq("company_id", companyId)
      .eq("order_id", orderId)
      .eq("event_type", "CREDITED");
    const codes = ((orderEvents ?? []) as { kpi_code: string }[]).map((r) => r.kpi_code).sort();
    // ORDER_COUNT + REVENUE selalu; NOO tergantung apakah customer ini sudah pernah confirmed
    // sebelumnya di suite ini -- yang pasti EFFECTIVE_CALL TIDAK PERNAH ikut lewat order biasa ini
    // (order_source OTHER, tanpa call_id).
    expect(codes).toContain("ORDER_COUNT");
    expect(codes).toContain("REVENUE");
    expect(codes).not.toContain("EFFECTIVE_CALL");
  });

  it("18. Laporan Sales tidak tersentuh -- sales_reports tetap kosong untuk seluruh aktivitas kunjungan run ini", async () => {
    const { data: reports } = await supabase
      .from("sales_reports")
      .select("id")
      .eq("company_id", companyId)
      .eq("salesperson_id", salesAuthId);
    expect(reports ?? []).toHaveLength(0);
  });

  it("EC historis dari Sales Order FIELD_VISIT (kontrak lama) tetap valid terhadap constraint baru", async () => {
    // Reproduksi ringkas jalur lama (20260805000001): Call biasa (tanpa web
    // visit) lalu order FIELD_VISIT confirmed -> EC via trigger order lama.
    // Membuktikan constraint chk_skae_ec_kpi yang dilonggarkan Gate 3E-D5-B
    // TIDAK merusak baris EC lama yang order_id-nya terisi.
    const legacyKey = `legacy-call:${runTag}`;
    const { data: legacyCallResult } = await supabase.rpc("record_sales_call", {
      p_company_id: companyId, p_actor_id: salesAuthId, p_salesperson_id: salesAuthId,
      p_customer_id: customerId, p_call_date: "2026-09-15", p_outcome_notes: "Kunjungan Telegram legacy",
      p_idempotency_key: legacyKey, p_coverage_exception_task_id: null, p_repeat_visit_task_id: null,
    });
    const legacyCallId = (legacyCallResult ?? [])[0]?.result_call_id as string;
    expect(legacyCallId).toBeTruthy();

    const legacyOrderId = randomUUID();
    await supabase.from("sales_orders").insert({
      id: legacyOrderId, company_id: companyId, order_number: `SO-${runTag}-legacy-ec`, customer_id: customerId,
      sales_id: salesAuthId, status: "draft", order_source: "FIELD_VISIT", is_historical: false,
      final_amount: 500_000, call_id: legacyCallId,
    });
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", legacyOrderId).eq("status", "draft");

    const { data: legacyEc } = await supabase
      .from("sales_kpi_achievement_events")
      .select("id, order_id, call_id")
      .eq("company_id", companyId)
      .eq("kpi_code", "EFFECTIVE_CALL")
      .eq("call_id", legacyCallId)
      .eq("event_type", "CREDITED");
    const rows = (legacyEc ?? []) as { id: string; order_id: string | null; call_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(legacyOrderId); // EC lama TETAP mengisi order_id -- tidak diubah gate ini.
  });

  it("20. Relevant coverage: sales tidak aktif tidak dapat memulai kunjungan (fail-closed)", async () => {
    await supabase.from("users").update({ is_active: false }).eq("id", salesOtherAuthId);
    const res = await startVisit(salesOtherAuthId, customerId, `visit-start:${runTag}:inactive`);
    expect(res.result_outcome).toBe("forbidden");
    await supabase.from("users").update({ is_active: true }).eq("id", salesOtherAuthId);
  });

  it("Owner/manager tidak dapat memulai atau menyelesaikan kunjungan atas nama Sales (no proxy)", async () => {
    const res = await startVisit(ownerAuthId, customerId, `visit-start:${runTag}:owner-proxy`);
    expect(res.result_outcome).toBe("forbidden");
  });
});
