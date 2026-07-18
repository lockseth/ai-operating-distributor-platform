import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AutomationChannel,
  AutomationEventType,
  AutomationHealthSnapshot,
  AutomationJobStatus,
  AutomationOutboxListItem,
  ClaimAutomationJobsInput,
  ClaimAutomationJobsResult,
  ClaimedAutomationJob,
  CompleteAutomationJobInput,
  CompleteAutomationJobResult,
  EnqueueAutomationJobInput,
  EnqueueAutomationJobResult,
  FailAutomationJobInput,
  FailAutomationJobResult,
  ReplayAutomationJobInput,
  ReplayAutomationJobResult,
  RecordAutomationHeartbeatInput,
  RecordAutomationHeartbeatResult,
} from "./types";

export interface ResolvedAutomationCredential {
  id: string;
  companyId: string;
  scope: string[];
}

export interface AutomationRepository {
  resolveCredential(hash: string): Promise<ResolvedAutomationCredential | null>;
  claimJobs(input: ClaimAutomationJobsInput): Promise<ClaimAutomationJobsResult>;
  completeJob(input: CompleteAutomationJobInput): Promise<CompleteAutomationJobResult>;
  failJob(input: FailAutomationJobInput): Promise<FailAutomationJobResult>;
  replayJob(input: ReplayAutomationJobInput): Promise<ReplayAutomationJobResult>;
  enqueueJob(input: EnqueueAutomationJobInput): Promise<EnqueueAutomationJobResult>;
  listJobs(
    companyId: string,
    statuses?: AutomationJobStatus[],
  ): Promise<AutomationOutboxListItem[]>;
  getHealthSnapshot(companyId: string): Promise<AutomationHealthSnapshot>;
  recordHeartbeat(input: RecordAutomationHeartbeatInput): Promise<RecordAutomationHeartbeatResult>;
}

function firstRow<T>(data: unknown): T | null {
  return ((data ?? []) as T[])[0] ?? null;
}

export class SupabaseAutomationRepository implements AutomationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async resolveCredential(hash: string): Promise<ResolvedAutomationCredential | null> {
    const { data } = await this.client
      .from("n8n_inbound_credentials")
      .select("id, company_id, scope, status")
      .eq("credential_hash", hash)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return null;
    const row = data as { id: string; company_id: string; scope: string[] | null };
    return { id: row.id, companyId: row.company_id, scope: row.scope ?? [] };
  }

  async claimJobs(input: ClaimAutomationJobsInput): Promise<ClaimAutomationJobsResult> {
    const { data, error } = await this.client.rpc("claim_automation_jobs", {
      p_company_id: input.companyId,
      p_credential_id: input.credentialId,
      p_max_jobs: input.maxJobs,
      p_worker_label: input.workerLabel,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const rows = (data ?? []) as {
      result_outcome: string;
      job_id: string | null;
      event_type: string | null;
      channel: string | null;
      recipient_reference: string | null;
      payload: Record<string, unknown> | null;
      attempt_count: number | null;
      max_attempts: number | null;
    }[];

    if (rows.length === 0) return { outcome: "claimed", jobs: [] };

    const first = rows[0];
    if (first.result_outcome === "forbidden") return { outcome: "forbidden" };
    if (first.result_outcome === "invalid_max_jobs") return { outcome: "invalid_max_jobs" };

    const jobs: ClaimedAutomationJob[] = rows
      .filter((r) => r.result_outcome === "claimed" && r.job_id)
      .map((r) => ({
        jobId: r.job_id!,
        eventType: r.event_type as AutomationEventType,
        channel: r.channel as AutomationChannel,
        recipientReference: r.recipient_reference!,
        payload: r.payload ?? {},
        attemptCount: r.attempt_count ?? 0,
        maxAttempts: r.max_attempts ?? 0,
      }));
    return { outcome: "claimed", jobs };
  }

  async completeJob(input: CompleteAutomationJobInput): Promise<CompleteAutomationJobResult> {
    const { data, error } = await this.client.rpc("complete_automation_job", {
      p_company_id: input.companyId,
      p_credential_id: input.credentialId,
      p_job_id: input.jobId,
      p_provider_message_id: input.providerMessageId,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "completed" ||
      row.result_outcome === "already_completed" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "not_found" ||
      row.result_outcome === "invalid_state"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async failJob(input: FailAutomationJobInput): Promise<FailAutomationJobResult> {
    const { data, error } = await this.client.rpc("fail_automation_job", {
      p_company_id: input.companyId,
      p_credential_id: input.credentialId,
      p_job_id: input.jobId,
      p_error: input.error,
      p_retryable: input.retryable,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = firstRow<{ result_outcome: string; result_status: string | null }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "failed" ||
      row.result_outcome === "dead_letter" ||
      row.result_outcome === "retry_scheduled"
    ) {
      return { outcome: row.result_outcome, status: row.result_status as AutomationJobStatus };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "not_found" ||
      row.result_outcome === "invalid_state"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async replayJob(input: ReplayAutomationJobInput): Promise<ReplayAutomationJobResult> {
    const { data, error } = await this.client.rpc("replay_automation_job", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_credential_id: input.credentialId,
      p_job_id: input.jobId,
      p_reason: input.reason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "replayed" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "not_found" ||
      row.result_outcome === "invalid_state" ||
      row.result_outcome === "reason_required"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async enqueueJob(input: EnqueueAutomationJobInput): Promise<EnqueueAutomationJobResult> {
    const { data, error } = await this.client.rpc("enqueue_automation_job", {
      p_company_id: input.companyId,
      p_credential_id: input.credentialId,
      p_required_scope: input.requiredScope,
      p_event_type: input.eventType,
      p_channel: input.channel,
      p_recipient_user_id: input.recipientUserId,
      p_recipient_reference: input.recipientReference,
      p_payload: input.payload,
      p_idempotency_key: input.idempotencyKey,
      p_max_attempts: input.maxAttempts ?? null,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = firstRow<{ result_outcome: string; job_id: string | null }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if ((row.result_outcome === "enqueued" || row.result_outcome === "already_exists") && row.job_id) {
      return { outcome: row.result_outcome, jobId: row.job_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_event_type" ||
      row.result_outcome === "invalid_channel" ||
      row.result_outcome === "idempotency_key_required"
    ) {
      return { outcome: row.result_outcome };
    }
    return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
  }

  async listJobs(
    companyId: string,
    statuses?: AutomationJobStatus[],
  ): Promise<AutomationOutboxListItem[]> {
    let query = this.client
      .from("automation_outbox")
      .select(
        "id, event_type, channel, recipient_reference, status, attempt_count, max_attempts, available_at, sent_at, failed_at, last_error, created_at",
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (statuses && statuses.length > 0) query = query.in("status", statuses);

    const { data } = await query;
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      eventType: row.event_type as AutomationEventType,
      channel: row.channel as AutomationChannel,
      recipientReference: row.recipient_reference as string,
      status: row.status as AutomationJobStatus,
      attemptCount: row.attempt_count as number,
      maxAttempts: row.max_attempts as number,
      availableAt: row.available_at as string,
      sentAt: (row.sent_at as string | null) ?? null,
      failedAt: (row.failed_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      createdAt: row.created_at as string,
    }));
  }

  async getHealthSnapshot(companyId: string): Promise<AutomationHealthSnapshot> {
    const { data, error } = await this.client
      .from("automation_outbox")
      .select("status, available_at, locked_at, created_at, sent_at")
      .eq("company_id", companyId);

    if (error) {
      return {
        companyId,
        dbHealthy: false,
        pendingCount: 0,
        retryBacklogCount: 0,
        processingCount: 0,
        staleProcessingCount: 0,
        deadLetterCount: 0,
        sentLast24h: 0,
        lastClaimAt: null,
        n8nPollingHealthy: false,
        n8nLastHeartbeatAt: null,
        n8nReachable: null,
      };
    }

    // Heartbeat eksplisit (bukti reachability langsung) -- ambil heartbeat
    // TERBARU di antara semua credential automation.health milik tenant ini.
    // NULL berarti heartbeat belum pernah dipakai (bukan tanda tidak sehat).
    const { data: heartbeatRows } = await this.client
      .from("n8n_inbound_credentials")
      .select("last_heartbeat_at")
      .eq("company_id", companyId)
      .eq("status", "active")
      .contains("scope", ["automation.health"])
      .not("last_heartbeat_at", "is", null)
      .order("last_heartbeat_at", { ascending: false })
      .limit(1);
    const n8nLastHeartbeatAt =
      ((heartbeatRows ?? [])[0] as { last_heartbeat_at: string } | undefined)?.last_heartbeat_at ?? null;
    const heartbeatStaleThresholdMs = 10 * 60 * 1000; // 2x jadwal aodp-health-check (5 menit)
    const n8nReachable = n8nLastHeartbeatAt
      ? Date.now() - Date.parse(n8nLastHeartbeatAt) <= heartbeatStaleThresholdMs
      : null;

    const rows = (data ?? []) as {
      status: AutomationJobStatus;
      available_at: string;
      locked_at: string | null;
      created_at: string;
      sent_at: string | null;
    }[];

    const now = Date.now();
    const staleThresholdMs = 10 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const pendingCount = rows.filter((r) => r.status === "PENDING").length;
    const retryBacklogCount = rows.filter(
      (r) => r.status === "RETRY" && Date.parse(r.available_at) <= now,
    ).length;
    const processingRows = rows.filter((r) => r.status === "PROCESSING");
    const staleProcessingCount = processingRows.filter(
      (r) => r.locked_at && now - Date.parse(r.locked_at) > staleThresholdMs,
    ).length;
    const deadLetterCount = rows.filter((r) => r.status === "DEAD_LETTER").length;
    const sentLast24h = rows.filter(
      (r) => r.status === "SENT" && r.sent_at && Date.parse(r.sent_at) >= dayAgo,
    ).length;
    const lastClaimAt = processingRows
      .map((r) => r.locked_at)
      .filter((v): v is string => !!v)
      .sort()
      .pop();

    // Heuristik: dianggap n8n aktif polling jika ada backlog (pending/retry
    // due) TAPI juga ada aktivitas claim baru-baru ini, ATAU jika tidak ada
    // backlog sama sekali (tidak ada yang perlu di-claim, jadi tidak relevan
    // menilai "apakah n8n polling"). Degraded hanya jika ADA backlog namun
    // TIDAK ADA aktivitas claim dalam jendela wajar.
    const backlogExists = pendingCount > 0 || retryBacklogCount > 0;
    const recentClaimWindowMs = 15 * 60 * 1000;
    const recentClaim = lastClaimAt ? now - Date.parse(lastClaimAt) <= recentClaimWindowMs : false;
    const n8nPollingHealthy = !backlogExists || recentClaim;

    return {
      companyId,
      dbHealthy: true,
      pendingCount,
      retryBacklogCount,
      processingCount: processingRows.length,
      staleProcessingCount,
      deadLetterCount,
      sentLast24h,
      lastClaimAt: lastClaimAt ?? null,
      n8nPollingHealthy,
      n8nLastHeartbeatAt,
      n8nReachable,
    };
  }

  async recordHeartbeat(input: RecordAutomationHeartbeatInput): Promise<RecordAutomationHeartbeatResult> {
    const { data, error } = await this.client.rpc("record_automation_heartbeat", {
      p_company_id: input.companyId,
      p_credential_id: input.credentialId,
      p_worker_label: input.workerLabel,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };
    const row = firstRow<{ result_outcome: string; heartbeat_at: string | null }>(data);
    if (!row || row.result_outcome === "forbidden") return { outcome: "forbidden" };
    return { outcome: "recorded", heartbeatAt: row.heartbeat_at! };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation -- untuk test tanpa Supabase. Mereplikasi state
// machine yang sama persis dengan RPC Postgres (claim/complete/fail/replay/
// enqueue), termasuk aturan attempt_count, backoff, dan scope check.
// ---------------------------------------------------------------------------

interface StoredJob {
  id: string;
  companyId: string;
  eventType: AutomationEventType;
  channel: AutomationChannel;
  recipientUserId: string | null;
  recipientReference: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: AutomationJobStatus;
  availableAt: number;
  attemptCount: number;
  maxAttempts: number;
  lockedAt: number | null;
  lockedBy: string | null;
  sentAt: number | null;
  failedAt: number | null;
  lastError: string | null;
  providerMessageId: string | null;
  createdAt: number;
}

interface StoredCredentialSeed {
  id: string;
  companyId: string;
  scope: string[];
  status: "active" | "revoked";
  lastHeartbeatAt: number | null;
}

export class InMemoryAutomationRepository implements AutomationRepository {
  private readonly jobs: StoredJob[] = [];
  private readonly credentials: StoredCredentialSeed[] = [];
  private readonly actors = new Map<
    string,
    { companyId: string; role: string; active: boolean }
  >();
  private sequence = 0;
  /** Clock yang bisa di-override test untuk skenario stale-lock/backoff deterministik. */
  public clockNow: () => number = () => Date.now();

  seedCredential(input: {
    id: string;
    companyId: string;
    scope: string[];
    status?: "active" | "revoked";
  }): void {
    this.credentials.push({
      id: input.id,
      companyId: input.companyId,
      scope: input.scope,
      status: input.status ?? "active",
      lastHeartbeatAt: null,
    });
  }

  seedActor(actorId: string, companyId: string, role: string, active = true): void {
    this.actors.set(actorId, { companyId, role, active });
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private hasScope(credentialId: string, companyId: string, scope: string): boolean {
    const cred = this.credentials.find((c) => c.id === credentialId);
    if (!cred || cred.status !== "active") return false;
    if (cred.companyId !== companyId) return false;
    return cred.scope.includes(scope);
  }

  async resolveCredential(hash: string): Promise<ResolvedAutomationCredential | null> {
    // InMemory tidak mensimulasikan hashing -- test memakai credential id
    // langsung sebagai "hash" untuk kesederhanaan (lihat automation route
    // test yang memakai repository nyata untuk hash-path sesungguhnya).
    const cred = this.credentials.find((c) => c.id === hash && c.status === "active");
    return cred ? { id: cred.id, companyId: cred.companyId, scope: cred.scope } : null;
  }

  async claimJobs(input: ClaimAutomationJobsInput): Promise<ClaimAutomationJobsResult> {
    if (!this.hasScope(input.credentialId, input.companyId, "automation.claim")) {
      return { outcome: "forbidden" };
    }
    if (!Number.isInteger(input.maxJobs) || input.maxJobs <= 0 || input.maxJobs > 50) {
      return { outcome: "invalid_max_jobs" };
    }

    const now = this.clockNow();
    const staleMs = 10 * 60 * 1000;
    const eligible = this.jobs
      .filter(
        (j) =>
          j.companyId === input.companyId &&
          ((["PENDING", "RETRY"].includes(j.status) && j.availableAt <= now) ||
            (j.status === "PROCESSING" && j.lockedAt !== null && now - j.lockedAt > staleMs)),
      )
      .sort((a, b) => a.availableAt - b.availableAt)
      .slice(0, input.maxJobs);

    const jobs: ClaimedAutomationJob[] = [];
    for (const job of eligible) {
      job.status = "PROCESSING";
      job.lockedAt = now;
      job.lockedBy = input.workerLabel;
      job.attemptCount += 1;
      jobs.push({
        jobId: job.id,
        eventType: job.eventType,
        channel: job.channel,
        recipientReference: job.recipientReference,
        payload: job.payload,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
      });
    }
    return { outcome: "claimed", jobs };
  }

  async completeJob(input: CompleteAutomationJobInput): Promise<CompleteAutomationJobResult> {
    if (!this.hasScope(input.credentialId, input.companyId, "automation.complete")) {
      return { outcome: "forbidden" };
    }
    const job = this.jobs.find((j) => j.id === input.jobId && j.companyId === input.companyId);
    if (!job) return { outcome: "not_found" };
    if (job.status === "SENT") return { outcome: "already_completed" };
    if (job.status !== "PROCESSING") return { outcome: "invalid_state" };

    job.status = "SENT";
    job.sentAt = this.clockNow();
    job.providerMessageId = input.providerMessageId;
    job.lockedAt = null;
    job.lockedBy = null;
    return { outcome: "completed" };
  }

  async failJob(input: FailAutomationJobInput): Promise<FailAutomationJobResult> {
    if (!this.hasScope(input.credentialId, input.companyId, "automation.fail")) {
      return { outcome: "forbidden" };
    }
    const job = this.jobs.find((j) => j.id === input.jobId && j.companyId === input.companyId);
    if (!job) return { outcome: "not_found" };
    if (job.status !== "PROCESSING") return { outcome: "invalid_state" };

    const sanitized = sanitizeAutomationErrorInMemory(input.error);
    const now = this.clockNow();

    if (!input.retryable) {
      job.status = "FAILED";
      job.failedAt = now;
      job.lastError = sanitized;
      job.lockedAt = null;
      job.lockedBy = null;
      return { outcome: "failed", status: "FAILED" };
    }

    if (job.attemptCount >= job.maxAttempts) {
      job.status = "DEAD_LETTER";
      job.failedAt = now;
      job.lastError = sanitized;
      job.lockedAt = null;
      job.lockedBy = null;
      return { outcome: "dead_letter", status: "DEAD_LETTER" };
    }

    const backoffMinutes = Math.min(2 ** job.attemptCount, 60);
    job.status = "RETRY";
    job.lastError = sanitized;
    job.availableAt = now + backoffMinutes * 60_000;
    job.lockedAt = null;
    job.lockedBy = null;
    return { outcome: "retry_scheduled", status: "RETRY" };
  }

  async replayJob(input: ReplayAutomationJobInput): Promise<ReplayAutomationJobResult> {
    let authorized = false;
    if (input.actorId) {
      const actor = this.actors.get(input.actorId);
      authorized = Boolean(
        actor?.active &&
          actor.companyId === input.companyId &&
          ["owner", "manager", "super_admin"].includes(actor.role),
      );
    } else if (input.credentialId) {
      authorized = this.hasScope(input.credentialId, input.companyId, "automation.replay");
    }
    if (!authorized) return { outcome: "forbidden" };
    if (!input.reason || input.reason.trim().length < 3) return { outcome: "reason_required" };

    const job = this.jobs.find((j) => j.id === input.jobId && j.companyId === input.companyId);
    if (!job) return { outcome: "not_found" };
    if (!["DEAD_LETTER", "FAILED"].includes(job.status)) return { outcome: "invalid_state" };

    job.status = "PENDING";
    job.availableAt = this.clockNow();
    job.attemptCount = 0;
    job.lockedAt = null;
    job.lockedBy = null;
    job.lastError = null;
    job.failedAt = null;
    return { outcome: "replayed" };
  }

  async enqueueJob(input: EnqueueAutomationJobInput): Promise<EnqueueAutomationJobResult> {
    if (!this.hasScope(input.credentialId, input.companyId, input.requiredScope)) {
      return { outcome: "forbidden" };
    }
    if (!["MORNING_BRIEF", "KPI_DAILY_SUMMARY"].includes(input.eventType)) {
      return { outcome: "invalid_event_type" };
    }
    if (!["telegram", "whatsapp"].includes(input.channel)) {
      return { outcome: "invalid_channel" };
    }
    if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
      return { outcome: "idempotency_key_required" };
    }

    const existing = this.jobs.find(
      (j) => j.companyId === input.companyId && j.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { outcome: "already_exists", jobId: existing.id };

    const now = this.clockNow();
    const job: StoredJob = {
      id: this.nextId("job"),
      companyId: input.companyId,
      eventType: input.eventType,
      channel: input.channel,
      recipientUserId: input.recipientUserId,
      recipientReference: input.recipientReference,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
      availableAt: now,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 5,
      lockedAt: null,
      lockedBy: null,
      sentAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      createdAt: now,
    };
    this.jobs.push(job);
    return { outcome: "enqueued", jobId: job.id };
  }

  async listJobs(
    companyId: string,
    statuses?: AutomationJobStatus[],
  ): Promise<AutomationOutboxListItem[]> {
    return this.jobs
      .filter(
        (j) => j.companyId === companyId && (!statuses || statuses.includes(j.status)),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => ({
        id: j.id,
        eventType: j.eventType,
        channel: j.channel,
        recipientReference: j.recipientReference,
        status: j.status,
        attemptCount: j.attemptCount,
        maxAttempts: j.maxAttempts,
        availableAt: new Date(j.availableAt).toISOString(),
        sentAt: j.sentAt ? new Date(j.sentAt).toISOString() : null,
        failedAt: j.failedAt ? new Date(j.failedAt).toISOString() : null,
        lastError: j.lastError,
        createdAt: new Date(j.createdAt).toISOString(),
      }));
  }

  async getHealthSnapshot(companyId: string): Promise<AutomationHealthSnapshot> {
    const now = this.clockNow();
    const rows = this.jobs.filter((j) => j.companyId === companyId);
    const staleMs = 10 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const pendingCount = rows.filter((r) => r.status === "PENDING").length;
    const retryBacklogCount = rows.filter(
      (r) => r.status === "RETRY" && r.availableAt <= now,
    ).length;
    const processingRows = rows.filter((r) => r.status === "PROCESSING");
    const staleProcessingCount = processingRows.filter(
      (r) => r.lockedAt !== null && now - r.lockedAt > staleMs,
    ).length;
    const deadLetterCount = rows.filter((r) => r.status === "DEAD_LETTER").length;
    const sentLast24h = rows.filter(
      (r) => r.status === "SENT" && r.sentAt !== null && r.sentAt >= dayAgo,
    ).length;
    const lastClaimAtMs = processingRows
      .map((r) => r.lockedAt)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b)
      .pop();

    const backlogExists = pendingCount > 0 || retryBacklogCount > 0;
    const recentClaim = lastClaimAtMs ? now - lastClaimAtMs <= 15 * 60 * 1000 : false;

    const heartbeats = this.credentials
      .filter((c) => c.companyId === companyId && c.status === "active" && c.scope.includes("automation.health"))
      .map((c) => c.lastHeartbeatAt)
      .filter((v): v is number => v !== null)
      .sort((a, b) => b - a);
    const n8nLastHeartbeatAtMs = heartbeats[0] ?? null;
    const n8nReachable = n8nLastHeartbeatAtMs !== null ? now - n8nLastHeartbeatAtMs <= 10 * 60 * 1000 : null;

    return {
      companyId,
      dbHealthy: true,
      pendingCount,
      retryBacklogCount,
      processingCount: processingRows.length,
      staleProcessingCount,
      deadLetterCount,
      sentLast24h,
      lastClaimAt: lastClaimAtMs ? new Date(lastClaimAtMs).toISOString() : null,
      n8nPollingHealthy: !backlogExists || recentClaim,
      n8nLastHeartbeatAt: n8nLastHeartbeatAtMs !== null ? new Date(n8nLastHeartbeatAtMs).toISOString() : null,
      n8nReachable,
    };
  }

  async recordHeartbeat(input: RecordAutomationHeartbeatInput): Promise<RecordAutomationHeartbeatResult> {
    const cred = this.credentials.find((c) => c.id === input.credentialId);
    if (!cred || cred.status !== "active" || cred.companyId !== input.companyId || !cred.scope.includes("automation.health")) {
      return { outcome: "forbidden" };
    }
    const now = this.clockNow();
    cred.lastHeartbeatAt = now;
    return { outcome: "recorded", heartbeatAt: new Date(now).toISOString() };
  }
}

function sanitizeAutomationErrorInMemory(raw: string): string {
  let sanitized = raw.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  sanitized = sanitized.replace(/Authorization:\s*\S+/gi, "Authorization: [redacted]");
  return sanitized.slice(0, 500);
}
