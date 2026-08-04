// =============================================================================
// Gate 3E-D2-B (Telegram Self-Service Password Reset) -- DB-backed, Postgres/
// Supabase NYATA (bukan mock). Membuktikan migration
// 20260915000001_gate_3e_d2_b_telegram_self_service_password_reset.sql
// (telegram_self_service_begin/finalize/fail_password_reset()) terhadap
// kontrak gate: self-service only (p_actor_id = p_target_user_id), allowlist
// role {owner,admin,sales}, pairing telegram_identities aktif wajib,
// fail-closed sebelum Auth API dipanggil, idempotency in-flight per target,
// dan audit log tersimpan dengan action pendek (<=50 char, VARCHAR(50)).
//
// Ditambahkan pada Gate 3E-D2-B2 setelah audit D2-B1 menemukan bug kritis:
// unit test (workflow.test.ts, InMemoryTelegramSelfServicePasswordResetRepository)
// TIDAK mensimulasikan batas audit_logs.action VARCHAR(50), sehingga tidak
// bisa mendeteksi bahwa RPC gagal total (transaksi rollback) setiap kali
// mencapai jalur sukses. Test ini memanggil RPC sungguhan lewat service-role
// client (pola identik gate-3e-d2-a-r1-super-admin-password-reset.integration.test.ts)
// justru untuk menutup celah itu.
//
// Pola identik gate-3e-d2-a-r1-super-admin-password-reset.integration.test.ts.
// Skip graceful jika kredensial Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

type BeginOutcomeRow = { result_outcome: string; target_email?: string | null; target_company_id?: string | null };
type OutcomeRow = { result_outcome: string };

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3E-D2-B integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D2-B: telegram_self_service_{begin,finalize,fail}_password_reset() (Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed2b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let ownerRoleId = "";
  let adminRoleId = "";
  let salesRoleId = "";
  let superAdminRoleId = "";

  const createdAuthUserIds: string[] = [];
  const createdCompanyIds: string[] = [];
  let chatIdCounter = 910_000;

  async function createCompany(key: string): Promise<string> {
    const id = randomUUID();
    const { error } = await service.from("companies").insert({
      id,
      name: `Gate 3E-D2-B ${runTag} ${key}`,
      slug: `gate-3e-d2-b-${runTag}-${key}`.toLowerCase(),
    });
    if (error) throw new Error(`gagal buat company ${key}: ${error.message}`);
    createdCompanyIds.push(id);
    return id;
  }

  async function createAuthUser(key: string): Promise<{ id: string; email: string; password: string }> {
    const email = `${runTag}-${key}@itest.test`;
    const password = randomUUID();
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${key}: ${error?.message}`);
    createdAuthUserIds.push(data.user.id);
    return { id: data.user.id, email, password };
  }

  async function createTenantUser(
    key: string,
    companyId: string,
    roleId: string,
    opts: { isActive?: boolean } = {}
  ): Promise<{ id: string; email: string; password: string }> {
    const u = await createAuthUser(key);
    const { error: profileErr } = await service.from("users").insert({
      id: u.id,
      company_id: companyId,
      email: u.email,
      full_name: `Itest ${key}`,
      is_active: opts.isActive ?? true,
    });
    if (profileErr) throw new Error(`gagal buat profile ${key}: ${profileErr.message}`);
    if (roleId) {
      const { error: roleErr } = await service.from("user_roles").insert({ user_id: u.id, role_id: roleId, company_id: companyId });
      if (roleErr) throw new Error(`gagal assign role ${key}: ${roleErr.message}`);
    }
    return u;
  }

  /** Pairing telegram_identities aktif -- backstop RPC mensyaratkan ini (kontrak gate). */
  async function pairTelegram(userId: string, companyId: string): Promise<number> {
    const chatId = chatIdCounter++;
    const { error } = await service.from("telegram_identities").insert({
      company_id: companyId, user_id: userId, telegram_chat_id: chatId, is_active: true,
    });
    if (error) throw new Error(`gagal pairing telegram: ${error.message}`);
    return chatId;
  }

  async function getUserRow(userId: string) {
    const { data } = await service
      .from("users")
      .select("id, company_id, email, is_active, must_change_password")
      .eq("id", userId)
      .maybeSingle();
    return data as { id: string; company_id: string; email: string; is_active: boolean; must_change_password: boolean } | null;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);
    const { data: roles } = await service.from("roles").select("id, name").is("company_id", null).in("name", ["owner", "admin", "sales", "super_admin"]);
    const byName = Object.fromEntries(((roles ?? []) as { id: string; name: string }[]).map((r) => [r.name, r.id]));
    ownerRoleId = byName.owner;
    adminRoleId = byName.admin;
    salesRoleId = byName.sales;
    superAdminRoleId = byName.super_admin;
    expect(ownerRoleId).toBeTruthy();
    expect(adminRoleId).toBeTruthy();
    expect(salesRoleId).toBeTruthy();
    expect(superAdminRoleId).toBeTruthy();
  }, 30000);

  afterAll(async () => {
    if (!service) return;
    await service.from("tenant_user_password_reset_operations").delete().in("actor_id", createdAuthUserIds);
    await service.from("audit_logs").delete().in("company_id", createdCompanyIds);
    await service.from("telegram_identities").delete().in("user_id", createdAuthUserIds);
    await service.from("user_roles").delete().in("user_id", createdAuthUserIds);
    await service.from("users").delete().in("id", createdAuthUserIds);
    await service.from("companies").delete().in("id", createdCompanyIds);
    for (const id of createdAuthUserIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1. begin() sukses -- db_committed, must_change_password=TRUE, operation record tersimpan, audit action pendek (<=50 char) tersimpan", async () => {
    const companyId = await createCompany("happy-begin");
    const target = await createTenantUser("happy-begin-target", companyId, ownerRoleId);
    await pairTelegram(target.id, companyId);
    const operationId = randomUUID();

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("db_committed");
    expect((begin.data as BeginOutcomeRow[])[0].target_email).toBe(target.email);

    const row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);
    expect(row?.company_id).toBe(companyId);

    const op = await service
      .from("tenant_user_password_reset_operations")
      .select("status, target_user_id, actor_id")
      .eq("id", operationId)
      .maybeSingle();
    expect(op.data?.status).toBe("db_committed");
    expect(op.data?.target_user_id).toBe(target.id);
    expect(op.data?.actor_id).toBe(target.id);

    const audit = await service
      .from("audit_logs")
      .select("action")
      .eq("entity_id", target.id)
      .eq("action", "tenant_user.telegram_reset_started");
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0].action.length).toBeLessThanOrEqual(50);
  });

  it("2. finalize() sukses SETELAH begin() -- succeeded, baseline hash disegarkan, audit action pendek tersimpan", async () => {
    const companyId = await createCompany("happy-finalize");
    const target = await createTenantUser("happy-finalize-target", companyId, adminRoleId);
    await pairTelegram(target.id, companyId);
    const operationId = randomUUID();

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
    });
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("db_committed");

    // Tahap Auth API sungguhan (di TS repository.ts, RPC ini tidak menyentuh
    // Auth) -- disimulasikan di sini persis seperti resetTenantUserPassword().
    const authUpdate = await service.auth.admin.updateUserById(target.id, { password: randomUUID() });
    expect(authUpdate.error).toBeNull();

    const finalize = await service.rpc("telegram_self_service_finalize_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
    });
    expect(finalize.error).toBeNull();
    expect((finalize.data as OutcomeRow[])[0].result_outcome).toBe("succeeded");

    const op = await service.from("tenant_user_password_reset_operations").select("status").eq("id", operationId).maybeSingle();
    expect(op.data?.status).toBe("succeeded");

    const audit = await service
      .from("audit_logs")
      .select("action")
      .eq("entity_id", target.id)
      .eq("action", "tenant_user.telegram_reset_completed");
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0].action.length).toBeLessThanOrEqual(50);

    // Idempotent replay -- panggil finalize() lagi dengan operationId sama
    // (mis. retry jaringan) tetap "succeeded", tidak menghasilkan audit kedua.
    const replay = await service.rpc("telegram_self_service_finalize_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
    });
    expect((replay.data as OutcomeRow[])[0].result_outcome).toBe("succeeded");
    const auditAfterReplay = await service
      .from("audit_logs")
      .select("action")
      .eq("entity_id", target.id)
      .eq("action", "tenant_user.telegram_reset_completed");
    expect(auditAfterReplay.data).toHaveLength(1); // tidak bertambah
  });

  it("3. fail() sukses SETELAH begin() -- failed, must_change_password TETAP TRUE (fail-closed dipertahankan), audit action pendek tersimpan", async () => {
    const companyId = await createCompany("happy-fail");
    const target = await createTenantUser("happy-fail-target", companyId, salesRoleId);
    await pairTelegram(target.id, companyId);
    const operationId = randomUUID();

    await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
    });

    const fail = await service.rpc("telegram_self_service_fail_password_reset", {
      p_operation_id: operationId,
      p_actor_id: target.id,
      p_target_user_id: target.id,
      p_reason: "auth_update_failed",
    });
    expect(fail.error).toBeNull();
    expect((fail.data as OutcomeRow[])[0].result_outcome).toBe("failed");

    const op = await service.from("tenant_user_password_reset_operations").select("status, failure_reason").eq("id", operationId).maybeSingle();
    expect(op.data?.status).toBe("failed");
    expect(op.data?.failure_reason).toBe("auth_update_failed");

    // fail-closed dipertahankan -- must_change_password TIDAK dibersihkan oleh fail().
    const row = await getUserRow(target.id);
    expect(row?.must_change_password).toBe(true);

    const audit = await service
      .from("audit_logs")
      .select("action")
      .eq("entity_id", target.id)
      .eq("action", "tenant_user.telegram_reset_failed");
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0].action.length).toBeLessThanOrEqual(50);
  });

  it("4. Concurrent begin() pada target yang sama -- hanya SATU operasi aktif (partial unique index sungguhan)", async () => {
    const companyId = await createCompany("in-flight");
    const target = await createTenantUser("in-flight-target", companyId, ownerRoleId);
    await pairTelegram(target.id, companyId);

    const [first, second] = await Promise.all([
      service.rpc("telegram_self_service_begin_password_reset", {
        p_operation_id: randomUUID(), p_actor_id: target.id, p_target_user_id: target.id,
      }),
      service.rpc("telegram_self_service_begin_password_reset", {
        p_operation_id: randomUUID(), p_actor_id: target.id, p_target_user_id: target.id,
      }),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const outcomes = [
      (first.data as BeginOutcomeRow[])[0].result_outcome,
      (second.data as BeginOutcomeRow[])[0].result_outcome,
    ].sort();
    expect(outcomes).toEqual(["already_in_progress", "db_committed"]);

    const inFlight = await service
      .from("tenant_user_password_reset_operations")
      .select("id")
      .eq("target_user_id", target.id)
      .in("status", ["started", "db_committed"]);
    expect(inFlight.data).toHaveLength(1); // persis satu operasi aktif di DB
  });

  it("5. Idempotency retry -- operationId SAMA di-retry pada begin() mengembalikan outcome yang sudah tercatat, tidak mengulang mutasi", async () => {
    const companyId = await createCompany("idem-retry");
    const target = await createTenantUser("idem-retry-target", companyId, ownerRoleId);
    await pairTelegram(target.id, companyId);
    const operationId = randomUUID();

    const first = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId, p_actor_id: target.id, p_target_user_id: target.id,
    });
    expect((first.data as BeginOutcomeRow[])[0].result_outcome).toBe("db_committed");

    const retry = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId, p_actor_id: target.id, p_target_user_id: target.id,
    });
    expect(retry.error).toBeNull();
    expect((retry.data as BeginOutcomeRow[])[0].result_outcome).toBe("db_committed"); // idempotent, bukan already_in_progress
    expect((retry.data as BeginOutcomeRow[])[0].target_email).toBe(target.email);

    const audit = await service
      .from("audit_logs")
      .select("action")
      .eq("entity_id", target.id)
      .eq("action", "tenant_user.telegram_reset_started");
    expect(audit.data).toHaveLength(1); // retry tidak menghasilkan audit/mutasi kedua
  });

  it("6a. actor != target ditolak forbidden pada begin() -- zero mutation", async () => {
    const companyId = await createCompany("actor-mismatch-begin");
    const actor = await createTenantUser("actor-mismatch-begin-actor", companyId, ownerRoleId);
    const target = await createTenantUser("actor-mismatch-begin-target", companyId, adminRoleId);
    await pairTelegram(target.id, companyId);

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: actor.id, p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("forbidden");
    expect((await getUserRow(target.id))?.must_change_password).toBe(false);
  });

  it("6b. actor != target ditolak forbidden pada finalize() dan fail() -- RPC re-verifikasi independen, bukan hanya mempercayai TS", async () => {
    const companyId = await createCompany("actor-mismatch-post");
    const target = await createTenantUser("actor-mismatch-post-target", companyId, salesRoleId);
    const otherActor = await createTenantUser("actor-mismatch-post-other", companyId, salesRoleId);
    await pairTelegram(target.id, companyId);
    const operationId = randomUUID();

    await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: operationId, p_actor_id: target.id, p_target_user_id: target.id,
    });

    const finalize = await service.rpc("telegram_self_service_finalize_password_reset", {
      p_operation_id: operationId, p_actor_id: otherActor.id, p_target_user_id: target.id,
    });
    expect((finalize.data as OutcomeRow[])[0].result_outcome).toBe("forbidden");

    const fail = await service.rpc("telegram_self_service_fail_password_reset", {
      p_operation_id: operationId, p_actor_id: otherActor.id, p_target_user_id: target.id, p_reason: "x",
    });
    expect((fail.data as OutcomeRow[])[0].result_outcome).toBe("forbidden");

    // Operasi asli TIDAK terganggu oleh percobaan actor lain.
    const op = await service.from("tenant_user_password_reset_operations").select("status").eq("id", operationId).maybeSingle();
    expect(op.data?.status).toBe("db_committed");
  });

  it("7a. Target tanpa telegram pairing aktif ditolak -- not_paired, fail-closed, zero mutation", async () => {
    const companyId = await createCompany("not-paired");
    const target = await createTenantUser("not-paired-target", companyId, ownerRoleId);
    // TIDAK dipair -- pairTelegram() sengaja tidak dipanggil.

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: target.id, p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("not_paired");
    expect((await getUserRow(target.id))?.must_change_password).toBe(false);
  });

  it("7b. Target inactive ditolak -- target_inactive, zero mutation", async () => {
    const companyId = await createCompany("target-inactive");
    const target = await createTenantUser("target-inactive-target", companyId, adminRoleId, { isActive: false });
    await pairTelegram(target.id, companyId);

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: target.id, p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("target_inactive");
  });

  it("7c. Role terlarang (super_admin) ditolak -- target_role_not_resettable, zero mutation", async () => {
    const companyId = await createCompany("role-forbidden");
    const target = await createTenantUser("role-forbidden-target", companyId, superAdminRoleId);
    await pairTelegram(target.id, companyId);

    const begin = await service.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: target.id, p_target_user_id: target.id,
    });
    expect(begin.error).toBeNull();
    expect((begin.data as BeginOutcomeRow[])[0].result_outcome).toBe("target_role_not_resettable");
    expect((await getUserRow(target.id))?.must_change_password).toBe(false);
  });

  it("8. anon/authenticated tidak bisa memanggil ketiga RPC secara langsung (hanya service_role)", async () => {
    const anon = createServiceClient(env!.url, env!.anonKey);
    const begin = await anon.rpc("telegram_self_service_begin_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: randomUUID(), p_target_user_id: randomUUID(),
    });
    expect(begin.error).not.toBeNull();

    const finalize = await anon.rpc("telegram_self_service_finalize_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: randomUUID(), p_target_user_id: randomUUID(),
    });
    expect(finalize.error).not.toBeNull();

    const fail = await anon.rpc("telegram_self_service_fail_password_reset", {
      p_operation_id: randomUUID(), p_actor_id: randomUUID(), p_target_user_id: randomUUID(), p_reason: "x",
    });
    expect(fail.error).not.toBeNull();
  });
});
