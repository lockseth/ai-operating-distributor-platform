import { describe, expect, it } from "vitest";
import { InMemoryAutomationRepository } from "./repository";

const COMPANY = "waluyo";
const OTHER_COMPANY = "other-co";
const CRED_FULL = "cred-full";
const CRED_CLAIM_ONLY = "cred-claim-only";
const CRED_OTHER_COMPANY = "cred-other";
const OWNER = "owner-1";
const SALESMAN = "salesman-1";

function seedFullCredential(repo: InMemoryAutomationRepository) {
  repo.seedCredential({
    id: CRED_FULL,
    companyId: COMPANY,
    scope: [
      "automation.claim",
      "automation.complete",
      "automation.fail",
      "automation.replay",
      "automation.health",
      "automation.morning_brief.generate",
    ],
  });
}

// ---------------------------------------------------------------------------
// Idempotency (enqueue)
// ---------------------------------------------------------------------------
describe("enqueueJob -- idempotency", () => {
  it("idempotency_key sama dua kali -> baris tunggal, outcome kedua already_exists", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);

    const first = await repo.enqueueJob({
      companyId: COMPANY,
      credentialId: CRED_FULL,
      requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF",
      channel: "telegram",
      recipientUserId: SALESMAN,
      recipientReference: "12345",
      payload: { text: "halo" },
      idempotencyKey: "morning_brief:salesman-1:2026-08-10",
    });
    const second = await repo.enqueueJob({
      companyId: COMPANY,
      credentialId: CRED_FULL,
      requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF",
      channel: "telegram",
      recipientUserId: SALESMAN,
      recipientReference: "12345",
      payload: { text: "halo lagi" },
      idempotencyKey: "morning_brief:salesman-1:2026-08-10",
    });

    expect(first.outcome).toBe("enqueued");
    expect(second.outcome).toBe("already_exists");
    if (first.outcome === "enqueued" && second.outcome === "already_exists") {
      expect(second.jobId).toBe(first.jobId);
    }
    const jobs = await repo.listJobs(COMPANY);
    expect(jobs).toHaveLength(1);
  });

  it("scope tidak sesuai -> forbidden, tidak membuat baris", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: CRED_CLAIM_ONLY, companyId: COMPANY, scope: ["automation.claim"] });

    const result = await repo.enqueueJob({
      companyId: COMPANY,
      credentialId: CRED_CLAIM_ONLY,
      requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF",
      channel: "telegram",
      recipientUserId: SALESMAN,
      recipientReference: "12345",
      payload: {},
      idempotencyKey: "k1",
    });
    expect(result.outcome).toBe("forbidden");
    expect(await repo.listJobs(COMPANY)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Atomic claim / concurrency (InMemory serial proof -- proof konkurensi
// sungguhan lewat DB nyata ada di outbox.integration.test.ts)
// ---------------------------------------------------------------------------
describe("claimJobs -- atomic claim", () => {
  it("job yang sudah PROCESSING (belum stale) tidak ikut ter-claim ulang", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1",
    });

    const first = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    const second = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w2" });

    expect(first.outcome).toBe("claimed");
    expect(second.outcome).toBe("claimed");
    if (first.outcome === "claimed" && second.outcome === "claimed") {
      expect(first.jobs).toHaveLength(1);
      expect(second.jobs).toHaveLength(0); // sudah PROCESSING, tidak eligible lagi
    }
  });

  it("attempt_count bertambah setiap kali di-claim", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 3,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome === "claimed") {
      expect(claimed.jobs[0].attemptCount).toBe(1);
    }
  });

  it("stale PROCESSING (locked_at lama) eligible di-reclaim", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    let now = 1_000_000;
    repo.clockNow = () => now;

    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1",
    });
    const firstClaim = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "worker-dead" });
    expect(firstClaim.outcome).toBe("claimed");

    // worker-dead crash, tidak pernah complete/fail. 11 menit berlalu -> stale.
    now += 11 * 60 * 1000;
    const reclaim = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "worker-recovery" });
    expect(reclaim.outcome).toBe("claimed");
    if (reclaim.outcome === "claimed") {
      expect(reclaim.jobs).toHaveLength(1);
      expect(reclaim.jobs[0].attemptCount).toBe(2); // sudah pernah di-claim worker-dead (1), sekarang lagi (2)
    }
  });

  it("job dengan available_at di masa depan (RETRY belum due) tidak ikut ter-claim", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 5,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");
    const jobId = claimed.jobs[0].jobId;

    await repo.failJob({ companyId: COMPANY, credentialId: CRED_FULL, jobId, error: "timeout", retryable: true });

    const secondAttempt = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w2" });
    expect(secondAttempt.outcome).toBe("claimed");
    if (secondAttempt.outcome === "claimed") {
      expect(secondAttempt.jobs).toHaveLength(0); // backoff belum lewat
    }
  });
});

// ---------------------------------------------------------------------------
// Complete -- idempotent
// ---------------------------------------------------------------------------
describe("completeJob", () => {
  it("retry complete pada job yang sudah SENT -> already_completed, bukan error", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1",
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");
    const jobId = claimed.jobs[0].jobId;

    const first = await repo.completeJob({ companyId: COMPANY, credentialId: CRED_FULL, jobId, providerMessageId: "msg-1" });
    const retry = await repo.completeJob({ companyId: COMPANY, credentialId: CRED_FULL, jobId, providerMessageId: "msg-1" });

    expect(first.outcome).toBe("completed");
    expect(retry.outcome).toBe("already_completed");

    const jobs = await repo.listJobs(COMPANY, ["SENT"]);
    expect(jobs).toHaveLength(1); // retry tidak menggandakan "pesan terkirim"
  });

  it("complete pada job yang masih PENDING (belum di-claim) -> invalid_state", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    const enqueued = await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1",
    });
    if (enqueued.outcome !== "enqueued") throw new Error("unexpected");
    const result = await repo.completeJob({ companyId: COMPANY, credentialId: CRED_FULL, jobId: enqueued.jobId, providerMessageId: null });
    expect(result.outcome).toBe("invalid_state");
  });
});

// ---------------------------------------------------------------------------
// Fail -- retry/dead-letter
// ---------------------------------------------------------------------------
describe("failJob -- retry & dead-letter", () => {
  it("retryable=true, attempt < max_attempts -> RETRY dengan backoff", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 5,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");

    const result = await repo.failJob({
      companyId: COMPANY, credentialId: CRED_FULL, jobId: claimed.jobs[0].jobId,
      error: "Provider timeout", retryable: true,
    });
    expect(result.outcome).toBe("retry_scheduled");
    if (result.outcome === "retry_scheduled") expect(result.status).toBe("RETRY");
  });

  it("retryable=true, attempt >= max_attempts -> DEAD_LETTER", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 1,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");
    expect(claimed.jobs[0].attemptCount).toBe(1); // == max_attempts

    const result = await repo.failJob({
      companyId: COMPANY, credentialId: CRED_FULL, jobId: claimed.jobs[0].jobId,
      error: "Permanent rejection", retryable: true,
    });
    expect(result.outcome).toBe("dead_letter");
    if (result.outcome === "dead_letter") expect(result.status).toBe("DEAD_LETTER");
  });

  it("retryable=false -> FAILED langsung meski attempt masih jauh dari max", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 10,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");

    const result = await repo.failJob({
      companyId: COMPANY, credentialId: CRED_FULL, jobId: claimed.jobs[0].jobId,
      error: "invalid recipient_reference", retryable: false,
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.status).toBe("FAILED");
  });
});

// ---------------------------------------------------------------------------
// Replay -- controlled, tenant-scoped
// ---------------------------------------------------------------------------
describe("replayJob", () => {
  async function makeDeadLetterJob(repo: InMemoryAutomationRepository) {
    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1", maxAttempts: 1,
    });
    const claimed = await repo.claimJobs({ companyId: COMPANY, credentialId: CRED_FULL, maxJobs: 10, workerLabel: "w1" });
    if (claimed.outcome !== "claimed") throw new Error("unexpected");
    await repo.failJob({ companyId: COMPANY, credentialId: CRED_FULL, jobId: claimed.jobs[0].jobId, error: "x", retryable: true });
    return claimed.jobs[0].jobId;
  }

  it("Owner (actor manusia) berhasil replay job DEAD_LETTER, attempt_count reset", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedActor(OWNER, COMPANY, "owner");
    const jobId = await makeDeadLetterJob(repo);

    const result = await repo.replayJob({
      companyId: COMPANY, actorId: OWNER, credentialId: null, jobId, reason: "Sudah diperbaiki root cause",
    });
    expect(result.outcome).toBe("replayed");

    const jobs = await repo.listJobs(COMPANY, ["PENDING"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].attemptCount).toBe(0);
  });

  it("replay tanpa alasan ditolak", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedActor(OWNER, COMPANY, "owner");
    const jobId = await makeDeadLetterJob(repo);

    const result = await repo.replayJob({ companyId: COMPANY, actorId: OWNER, credentialId: null, jobId, reason: "" });
    expect(result.outcome).toBe("reason_required");
  });

  it("salesman (non-manager) tidak bisa replay", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedActor("sales-actor", COMPANY, "sales");
    const jobId = await makeDeadLetterJob(repo);

    const result = await repo.replayJob({
      companyId: COMPANY, actorId: "sales-actor", credentialId: null, jobId, reason: "coba replay",
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("cross-tenant replay ditolak (credential tenant lain)", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedCredential({ id: CRED_OTHER_COMPANY, companyId: OTHER_COMPANY, scope: ["automation.replay"] });
    const jobId = await makeDeadLetterJob(repo);

    const result = await repo.replayJob({
      companyId: COMPANY, actorId: null, credentialId: CRED_OTHER_COMPANY, jobId, reason: "coba tenant lain",
    });
    expect(result.outcome).toBe("forbidden");
  });

  it("replay pada job yang bukan DEAD_LETTER/FAILED -> invalid_state", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedActor(OWNER, COMPANY, "owner");
    const enqueued = await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "k1",
    });
    if (enqueued.outcome !== "enqueued") throw new Error("unexpected");

    const result = await repo.replayJob({
      companyId: COMPANY, actorId: OWNER, credentialId: null, jobId: enqueued.jobId, reason: "coba replay PENDING",
    });
    expect(result.outcome).toBe("invalid_state");
  });

  it("replay retry (idempotent) tidak membuat perubahan ganda", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedActor(OWNER, COMPANY, "owner");
    const jobId = await makeDeadLetterJob(repo);

    const first = await repo.replayJob({ companyId: COMPANY, actorId: OWNER, credentialId: null, jobId, reason: "replay pertama" });
    expect(first.outcome).toBe("replayed");
    // job sekarang PENDING, bukan DEAD_LETTER lagi -- replay kedua harus invalid_state
    const second = await repo.replayJob({ companyId: COMPANY, actorId: OWNER, credentialId: null, jobId, reason: "replay kedua" });
    expect(second.outcome).toBe("invalid_state");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (baca)
// ---------------------------------------------------------------------------
describe("Tenant isolation", () => {
  it("listJobs hanya mengembalikan job milik company sendiri", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedCredential({ id: CRED_OTHER_COMPANY, companyId: OTHER_COMPANY, scope: ["automation.morning_brief.generate"] });

    await repo.enqueueJob({
      companyId: COMPANY, credentialId: CRED_FULL, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: SALESMAN,
      recipientReference: "1", payload: {}, idempotencyKey: "a",
    });
    await repo.enqueueJob({
      companyId: OTHER_COMPANY, credentialId: CRED_OTHER_COMPANY, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: "other-sales",
      recipientReference: "2", payload: {}, idempotencyKey: "b",
    });

    const companyAJobs = await repo.listJobs(COMPANY);
    const companyBJobs = await repo.listJobs(OTHER_COMPANY);
    expect(companyAJobs).toHaveLength(1);
    expect(companyBJobs).toHaveLength(1);
  });

  it("getHealthSnapshot hanya menghitung job tenant sendiri", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedCredential({ id: CRED_OTHER_COMPANY, companyId: OTHER_COMPANY, scope: ["automation.morning_brief.generate"] });

    await repo.enqueueJob({
      companyId: OTHER_COMPANY, credentialId: CRED_OTHER_COMPANY, requiredScope: "automation.morning_brief.generate",
      eventType: "MORNING_BRIEF", channel: "telegram", recipientUserId: "other-sales",
      recipientReference: "2", payload: {}, idempotencyKey: "b",
    });

    const snapshot = await repo.getHealthSnapshot(COMPANY);
    expect(snapshot.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Authorization -- credential scope enforcement per operasi
// ---------------------------------------------------------------------------
describe("Authorization -- scope per operasi", () => {
  it("credential hanya punya automation.claim tidak bisa complete/fail/replay", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: CRED_CLAIM_ONLY, companyId: COMPANY, scope: ["automation.claim"] });

    const completeResult = await repo.completeJob({
      companyId: COMPANY, credentialId: CRED_CLAIM_ONLY, jobId: "any", providerMessageId: null,
    });
    const failResult = await repo.failJob({
      companyId: COMPANY, credentialId: CRED_CLAIM_ONLY, jobId: "any", error: "x", retryable: true,
    });
    const replayResult = await repo.replayJob({
      companyId: COMPANY, actorId: null, credentialId: CRED_CLAIM_ONLY, jobId: "any", reason: "coba",
    });

    expect(completeResult.outcome).toBe("forbidden");
    expect(failResult.outcome).toBe("forbidden");
    expect(replayResult.outcome).toBe("forbidden");
  });

  it("credential revoked ditolak", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: "cred-revoked", companyId: COMPANY, scope: ["automation.claim"], status: "revoked" });

    const result = await repo.claimJobs({ companyId: COMPANY, credentialId: "cred-revoked", maxJobs: 5, workerLabel: "w1" });
    expect(result.outcome).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Heartbeat -- bukti reachability n8n LANGSUNG (targeted closure gate: health
// sebelumnya hanya heuristik dari backlog, tidak pernah membuktikan n8n
// benar-benar hidup).
// ---------------------------------------------------------------------------
describe("recordHeartbeat -- reachability n8n", () => {
  it("credential tanpa scope automation.health -> forbidden, snapshot tetap n8nReachable=null", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: CRED_CLAIM_ONLY, companyId: COMPANY, scope: ["automation.claim"] });

    const result = await repo.recordHeartbeat({ companyId: COMPANY, credentialId: CRED_CLAIM_ONLY, workerLabel: "n8n-health-check" });
    expect(result.outcome).toBe("forbidden");

    const snapshot = await repo.getHealthSnapshot(COMPANY);
    expect(snapshot.n8nLastHeartbeatAt).toBeNull();
    expect(snapshot.n8nReachable).toBeNull(); // belum pernah dipakai -- BUKAN tanda tidak sehat
  });

  it("heartbeat baru saja tercatat -> n8nReachable=true", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);

    const result = await repo.recordHeartbeat({ companyId: COMPANY, credentialId: CRED_FULL, workerLabel: "n8n-health-check" });
    expect(result.outcome).toBe("recorded");

    const snapshot = await repo.getHealthSnapshot(COMPANY);
    expect(snapshot.n8nLastHeartbeatAt).not.toBeNull();
    expect(snapshot.n8nReachable).toBe(true);
  });

  it("heartbeat basi (>10 menit) -> n8nReachable=false (degradasi nyata, bukan tebakan)", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    let now = Date.parse("2026-08-10T00:00:00Z");
    repo.clockNow = () => now;

    await repo.recordHeartbeat({ companyId: COMPANY, credentialId: CRED_FULL, workerLabel: "n8n-health-check" });
    now += 11 * 60 * 1000; // 11 menit kemudian -- lewat ambang 10 menit

    const snapshot = await repo.getHealthSnapshot(COMPANY);
    expect(snapshot.n8nReachable).toBe(false);
  });

  it("heartbeat dari tenant lain tidak memengaruhi snapshot tenant ini (tenant isolation)", async () => {
    const repo = new InMemoryAutomationRepository();
    seedFullCredential(repo);
    repo.seedCredential({ id: CRED_OTHER_COMPANY, companyId: OTHER_COMPANY, scope: ["automation.health"] });

    await repo.recordHeartbeat({ companyId: OTHER_COMPANY, credentialId: CRED_OTHER_COMPANY, workerLabel: "w" });

    const snapshot = await repo.getHealthSnapshot(COMPANY);
    expect(snapshot.n8nLastHeartbeatAt).toBeNull();
    expect(snapshot.n8nReachable).toBeNull();
  });
});
