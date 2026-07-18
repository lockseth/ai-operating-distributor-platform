// =============================================================================
// DB-backed integration test -- Automation Outbox.
//
// Membuktikan hal-hal yang TIDAK BISA dibuktikan lewat InMemory/mock karena
// logic-nya sengaja hidup sebagai RPC PostgreSQL (FOR UPDATE SKIP LOCKED,
// UNIQUE constraint, RETURN QUERY type-cast) -- concurrency claim, idempotency
// enqueue, retry/dead-letter attempt_count, tenant isolation, dan replay.
// Hanya Postgres sungguhan yang bisa membuktikan dua worker yang claim
// BERSAMAAN (Promise.all, bukan sekuensial) benar-benar tidak pernah dapat
// baris yang sama.
//
// Setiap test membuat company + credential SENDIRI (bukan berbagi satu
// tenant lintas test) -- claim_automation_jobs mengambil job berdasarkan
// company_id tanpa memfilter idempotency_key, jadi berbagi satu tenant di
// banyak test membuat job "nyasar" antar test (job milik test lain ikut
// terklaim). Isolasi per-test menghilangkan kelas flake ini sepenuhnya.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak tersedia,
// ATAU kalau URL yang terbaca BUKAN loopback -- pola identik dengan
// achievement.integration.test.ts / commit-invalid-status.integration.test.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
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

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

const ALL_SCOPES = [
  "automation.claim",
  "automation.complete",
  "automation.fail",
  "automation.replay",
  "automation.health",
  "automation.morning_brief.generate",
  "automation.kpi_summary.generate",
];

describeIfDb("Automation Outbox Integration -- claim/idempotency/retry/replay/tenant isolation (Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const createdCompanyIds: string[] = [];

  beforeAll(() => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
  });

  afterAll(async () => {
    if (!supabase || createdCompanyIds.length === 0) return;
    await supabase.from("automation_outbox").delete().in("company_id", createdCompanyIds);
    await supabase.from("n8n_inbound_credentials").delete().in("company_id", createdCompanyIds);
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 30000);

  async function createTenant(scopes: string[] = ALL_SCOPES, status: "active" | "revoked" = "active") {
    const companyId = randomUUID();
    const credentialId = randomUUID();
    const rawToken = `${runTag}-${randomUUID()}`;
    await supabase.from("companies").insert({ id: companyId, name: `Verify Automation ${runTag}`, slug: `verify-auto-${randomUUID()}` });
    await supabase.from("n8n_inbound_credentials").insert({
      id: credentialId, company_id: companyId, credential_hash: hashToken(rawToken),
      scope: scopes, status, label: `verify-${runTag}`,
    });
    createdCompanyIds.push(companyId);
    return { companyId, credentialId };
  }

  async function enqueue(companyId: string, credentialId: string, idempotencyKey: string, maxAttempts = 5) {
    const { data } = await supabase.rpc("enqueue_automation_job", {
      p_company_id: companyId,
      p_credential_id: credentialId,
      p_required_scope: "automation.morning_brief.generate",
      p_event_type: "MORNING_BRIEF",
      p_channel: "telegram",
      p_recipient_user_id: null,
      p_recipient_reference: `verify-recipient-${randomUUID()}`,
      p_payload: { text: "halo", structured: { status: "OK" } },
      p_idempotency_key: idempotencyKey,
      p_max_attempts: maxAttempts,
    });
    return (data ?? [])[0] as { result_outcome: string; job_id: string };
  }

  it("11. enqueue dua kali dengan idempotency_key sama -> satu job (job_id sama, outcome kedua = already_exists)", async () => {
    const { companyId, credentialId } = await createTenant();
    const key = `${runTag}-idem-1`;
    const first = await enqueue(companyId, credentialId, key);
    expect(first.result_outcome).toBe("enqueued");

    const second = await enqueue(companyId, credentialId, key);
    expect(second.result_outcome).toBe("already_exists");
    expect(second.job_id).toBe(first.job_id);

    const { data: rows } = await supabase.from("automation_outbox").select("id").eq("company_id", companyId).eq("idempotency_key", key);
    expect(rows ?? []).toHaveLength(1);
  });

  it("12. dua worker claim BERSAMAAN (Promise.all, concurrency sungguhan) -> tidak ada overlap job_id", async () => {
    const { companyId, credentialId } = await createTenant();
    const jobIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const job = await enqueue(companyId, credentialId, `${runTag}-concurrent-${i}`);
      jobIds.push(job.job_id);
    }

    const [claimA, claimB] = await Promise.all([
      supabase.rpc("claim_automation_jobs", { p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 3, p_worker_label: "worker-A" }),
      supabase.rpc("claim_automation_jobs", { p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 3, p_worker_label: "worker-B" }),
    ]);

    const claimedByA = ((claimA.data ?? []) as { job_id: string }[]).map((r) => r.job_id);
    const claimedByB = ((claimB.data ?? []) as { job_id: string }[]).map((r) => r.job_id);
    const overlap = claimedByA.filter((id) => claimedByB.includes(id));

    expect(overlap).toHaveLength(0);
    expect(claimedByA.length + claimedByB.length).toBe(6);
    expect(new Set([...claimedByA, ...claimedByB])).toEqual(new Set(jobIds));
  });

  it("13-14. provider gagal sementara -> RETRY; retry berhasil -> SENT tanpa duplikasi", async () => {
    const { companyId, credentialId } = await createTenant();
    const key = `${runTag}-retry-success`;
    const enqueued = await enqueue(companyId, credentialId, key, 5);
    const { data: claimed } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-retry",
    });
    const job = (claimed ?? [])[0] as { job_id: string; attempt_count: number };
    expect(job.job_id).toBe(enqueued.job_id);
    expect(job.attempt_count).toBe(1);

    const { data: failResult } = await supabase.rpc("fail_automation_job", {
      p_company_id: companyId, p_credential_id: credentialId, p_job_id: job.job_id,
      p_error: "Telegram API timeout", p_retryable: true,
    });
    expect((failResult ?? [])[0]?.result_status).toBe("RETRY");

    // Simulasikan retry sukses: available_at diset ke masa lalu supaya claim langsung eligible.
    await supabase.from("automation_outbox").update({ available_at: new Date(Date.now() - 1000).toISOString() }).eq("id", job.job_id);

    const { data: reclaimed } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-retry-2",
    });
    const reclaimedJob = (reclaimed ?? [])[0] as { job_id: string; attempt_count: number };
    expect(reclaimedJob.job_id).toBe(job.job_id);
    expect(reclaimedJob.attempt_count).toBe(2); // attempt_count naik lagi di claim kedua

    const { data: completeResult } = await supabase.rpc("complete_automation_job", {
      p_company_id: companyId, p_credential_id: credentialId, p_job_id: job.job_id, p_provider_message_id: "msg-123",
    });
    expect((completeResult ?? [])[0]?.result_outcome).toBe("completed");

    // Retry ulang complete (idempotent) -> already_completed, bukan error/duplikasi.
    const { data: retryComplete } = await supabase.rpc("complete_automation_job", {
      p_company_id: companyId, p_credential_id: credentialId, p_job_id: job.job_id, p_provider_message_id: "msg-123",
    });
    expect((retryComplete ?? [])[0]?.result_outcome).toBe("already_completed");

    const { data: finalRow } = await supabase.from("automation_outbox").select("status").eq("id", job.job_id).single();
    expect((finalRow as { status: string }).status).toBe("SENT");
  });

  it("15-16. kegagalan permanen (max_attempts tercapai) -> DEAD_LETTER; replay terkontrol -> PENDING, attempt_count reset, audit tercatat", async () => {
    const { companyId, credentialId } = await createTenant();
    const key = `${runTag}-dead-letter`;
    const enqueued = await enqueue(companyId, credentialId, key, 1); // max_attempts=1

    const { data: claimed } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-dl",
    });
    const job = (claimed ?? [])[0] as { job_id: string; attempt_count: number; max_attempts: number };
    expect(job.job_id).toBe(enqueued.job_id);
    expect(job.attempt_count).toBe(1);
    expect(job.max_attempts).toBe(1);

    const { data: failResult } = await supabase.rpc("fail_automation_job", {
      p_company_id: companyId, p_credential_id: credentialId, p_job_id: job.job_id,
      p_error: "permanent provider rejection", p_retryable: true,
    });
    expect((failResult ?? [])[0]?.result_status).toBe("DEAD_LETTER");

    const { data: replayResult } = await supabase.rpc("replay_automation_job", {
      p_company_id: companyId, p_actor_id: null, p_credential_id: credentialId,
      p_job_id: job.job_id, p_reason: "verified fix, replay for demo",
    });
    expect((replayResult ?? [])[0]?.result_outcome).toBe("replayed");

    const { data: replayedRow } = await supabase.from("automation_outbox").select("status, attempt_count").eq("id", job.job_id).single();
    const row = replayedRow as { status: string; attempt_count: number };
    expect(row.status).toBe("PENDING");
    expect(row.attempt_count).toBe(0);

    const { data: auditRows } = await supabase
      .from("audit_logs")
      .select("action")
      .eq("entity_id", job.job_id)
      .eq("action", "automation.job_replayed");
    expect(auditRows ?? []).toHaveLength(1);
  });

  it("17. cross-tenant claim/replay ditolak -- credential company B tidak bisa claim/replay job company A", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const enqueued = await enqueue(tenantA.companyId, tenantA.credentialId, `${runTag}-cross-tenant`);

    const { data: crossClaim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: tenantB.companyId, p_credential_id: tenantB.credentialId, p_max_jobs: 5, p_worker_label: "worker-cross",
    });
    const crossClaimedIds = ((crossClaim ?? []) as { job_id: string | null }[]).map((r) => r.job_id);
    expect(crossClaimedIds).not.toContain(enqueued.job_id);

    // Credential B mencoba claim pakai company_id A (spoofing company_id) -> forbidden, scope check gagal karena credential B terikat company B.
    const { data: spoofClaim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: tenantA.companyId, p_credential_id: tenantB.credentialId, p_max_jobs: 5, p_worker_label: "worker-spoof",
    });
    expect((spoofClaim ?? [])[0]?.result_outcome).toBe("forbidden");

    const { data: claimedForReplay } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: tenantA.companyId, p_credential_id: tenantA.credentialId, p_max_jobs: 1, p_worker_label: "worker-for-replay",
    });
    const jobForReplay = (claimedForReplay ?? [])[0] as { job_id: string };
    await supabase.rpc("fail_automation_job", {
      p_company_id: tenantA.companyId, p_credential_id: tenantA.credentialId, p_job_id: jobForReplay.job_id,
      p_error: "force fail for cross-tenant replay test", p_retryable: false,
    });

    const { data: crossReplay } = await supabase.rpc("replay_automation_job", {
      p_company_id: tenantB.companyId, p_actor_id: null, p_credential_id: tenantB.credentialId,
      p_job_id: jobForReplay.job_id, p_reason: "attempted cross-tenant replay",
    });
    expect((crossReplay ?? [])[0]?.result_outcome).toBe("not_found"); // job tidak ditemukan di scope company B
  });

  it("18. anonymous/tanpa credential (credential_id acak/tidak terdaftar) ditolak forbidden di semua RPC", async () => {
    const { companyId } = await createTenant();
    const bogusCredentialId = randomUUID();
    const { data: claim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: bogusCredentialId, p_max_jobs: 1, p_worker_label: "worker-bogus",
    });
    expect((claim ?? [])[0]?.result_outcome).toBe("forbidden");

    const { data: enqueueResult } = await supabase.rpc("enqueue_automation_job", {
      p_company_id: companyId, p_credential_id: bogusCredentialId, p_required_scope: "automation.morning_brief.generate",
      p_event_type: "MORNING_BRIEF", p_channel: "telegram", p_recipient_user_id: null,
      p_recipient_reference: "x", p_payload: {}, p_idempotency_key: `${runTag}-bogus`, p_max_attempts: 5,
    });
    expect((enqueueResult ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("scope tidak mencukupi -> ditolak forbidden meski credential valid dan aktif", async () => {
    const { companyId, credentialId } = await createTenant(["automation.health"]);
    const { data: claim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-narrow",
    });
    expect((claim ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("revoked credential ditolak forbidden walau scope lengkap", async () => {
    const { companyId, credentialId } = await createTenant(ALL_SCOPES, "revoked");
    const { data: claim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-revoked",
    });
    expect((claim ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("stale PROCESSING (locked_at > 10 menit) recoverable -- worker lain bisa reclaim tanpa RPC/cron terpisah", async () => {
    const { companyId, credentialId } = await createTenant();
    const enqueued = await enqueue(companyId, credentialId, `${runTag}-stale-lock`);
    const { data: firstClaim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-dead",
    });
    expect((firstClaim ?? [])[0]?.job_id).toBe(enqueued.job_id);

    // Simulasikan worker mati: paksa locked_at ke 15 menit lalu (di luar ambang 10 menit).
    await supabase.from("automation_outbox").update({
      locked_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    }).eq("id", enqueued.job_id);

    const { data: secondClaim } = await supabase.rpc("claim_automation_jobs", {
      p_company_id: companyId, p_credential_id: credentialId, p_max_jobs: 1, p_worker_label: "worker-recovery",
    });
    const recovered = (secondClaim ?? [])[0] as { job_id: string; attempt_count: number };
    expect(recovered.job_id).toBe(enqueued.job_id);
    expect(recovered.attempt_count).toBe(2); // attempt_count naik lagi pada stale-reclaim
  });
});
