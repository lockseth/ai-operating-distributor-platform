// =============================================================================
// n8n Automation & Orchestration Foundation -- types.
//
// Namespace TERPISAH dari lib/automation/ (Automation Engine lama --
// rule-based, n8n_webhooks, HMAC push -- lihat n8n/README.md untuk status
// deprecated-nya). Modul ini adalah fondasi BARU: outbox pattern, n8n
// menarik (claim) job lewat internal API, autentikasi Bearer memakai ULANG
// n8n_inbound_credentials yang sudah di-hardening.
//
// n8n hanya orchestration/scheduling/delivery/retry. Konten (target, actual,
// achievement, EC Rate) SELALU dihitung lib/sales-kpi/* -- tidak pernah
// dihitung ulang di sini atau di n8n. Outbox murni antrian pengiriman.
// =============================================================================

export type AutomationEventType = "MORNING_BRIEF" | "KPI_DAILY_SUMMARY";
export type AutomationChannel = "telegram" | "whatsapp";
export type AutomationJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "SENT"
  | "RETRY"
  | "FAILED"
  | "DEAD_LETTER";

export interface ClaimedAutomationJob {
  jobId: string;
  eventType: AutomationEventType;
  channel: AutomationChannel;
  recipientReference: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
}

export interface ClaimAutomationJobsInput {
  companyId: string;
  credentialId: string;
  maxJobs: number;
  workerLabel: string;
}

export type ClaimAutomationJobsResult =
  | { outcome: "claimed"; jobs: ClaimedAutomationJob[] }
  | { outcome: "forbidden" | "invalid_max_jobs" }
  | { outcome: "unexpected_error"; error: string };

export interface CompleteAutomationJobInput {
  companyId: string;
  credentialId: string;
  jobId: string;
  providerMessageId: string | null;
}

export type CompleteAutomationJobResult =
  | { outcome: "completed" | "already_completed" }
  | { outcome: "forbidden" | "not_found" | "invalid_state" }
  | { outcome: "unexpected_error"; error: string };

export interface FailAutomationJobInput {
  companyId: string;
  credentialId: string;
  jobId: string;
  error: string;
  retryable: boolean;
}

export type FailAutomationJobResult =
  | { outcome: "failed" | "dead_letter" | "retry_scheduled"; status: AutomationJobStatus }
  | { outcome: "forbidden" | "not_found" | "invalid_state" }
  | { outcome: "unexpected_error"; error: string };

export interface ReplayAutomationJobInput {
  companyId: string;
  actorId: string | null;
  credentialId: string | null;
  jobId: string;
  reason: string;
}

export type ReplayAutomationJobResult =
  | { outcome: "replayed" }
  | { outcome: "forbidden" | "not_found" | "invalid_state" | "reason_required" }
  | { outcome: "unexpected_error"; error: string };

export interface EnqueueAutomationJobInput {
  companyId: string;
  credentialId: string;
  requiredScope: string;
  eventType: AutomationEventType;
  channel: AutomationChannel;
  recipientUserId: string | null;
  recipientReference: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  maxAttempts?: number;
}

export type EnqueueAutomationJobResult =
  | { outcome: "enqueued" | "already_exists"; jobId: string }
  | { outcome: "forbidden" | "invalid_event_type" | "invalid_channel" | "idempotency_key_required" }
  | { outcome: "unexpected_error"; error: string };

export interface AutomationOutboxListItem {
  id: string;
  eventType: AutomationEventType;
  channel: AutomationChannel;
  recipientReference: string;
  status: AutomationJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  sentAt: string | null;
  failedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface AutomationHealthSnapshot {
  companyId: string;
  dbHealthy: boolean;
  pendingCount: number;
  retryBacklogCount: number;
  processingCount: number;
  staleProcessingCount: number;
  deadLetterCount: number;
  sentLast24h: number;
  lastClaimAt: string | null;
  n8nPollingHealthy: boolean;
  /** Bukti reachability n8n LANGSUNG (heartbeat eksplisit), bukan heuristik dari backlog. Lihat n8nPollingHealthy untuk sinyal lama. */
  n8nLastHeartbeatAt: string | null;
  /** null = heartbeat belum pernah dipakai credential manapun di tenant ini (bukan tanda tidak sehat). */
  n8nReachable: boolean | null;
}

export interface RecordAutomationHeartbeatInput {
  companyId: string;
  credentialId: string;
  workerLabel: string;
}

export type RecordAutomationHeartbeatResult =
  | { outcome: "recorded"; heartbeatAt: string }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };
