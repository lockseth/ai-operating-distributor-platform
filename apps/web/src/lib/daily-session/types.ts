export type DailySessionStatus = "ACTIVE" | "CLOSED";

export interface DailySession {
  id: string;
  companyId: string;
  salesmanId: string;
  businessDate: string;
  status: DailySessionStatus;
  startedAt: string;
  startedBy: string;
  closedAt: string | null;
  closedBy: string | null;
  closeSummary: unknown;
}

export interface StartDailySessionInput {
  companyId: string;
  actorId: string;
  salesmanId: string;
  businessDate: string;
  idempotencyKey: string;
}

export type StartDailySessionResult =
  | { outcome: "started" | "already_started"; sessionId: string }
  | {
      outcome:
        | "forbidden"
        | "invalid_date"
        | "idempotency_key_required"
        | "salesperson_not_eligible";
    }
  | { outcome: "unexpected_error"; error: string };

export interface CloseDailySessionInput {
  companyId: string;
  actorId: string;
  sessionId: string;
  closeSummary?: unknown;
}

export type CloseDailySessionResult =
  | { outcome: "closed" | "already_closed" }
  | {
      outcome:
        | "forbidden"
        | "session_not_found"
        | "blocked_open_visits"
        | "blocked_open_deliveries";
    }
  | { outcome: "unexpected_error"; error: string };

export interface ReopenDailySessionInput {
  companyId: string;
  actorId: string;
  sessionId: string;
  reason: string;
}

export type ReopenDailySessionResult =
  | { outcome: "reopened" | "already_active" }
  | { outcome: "forbidden" | "session_not_found" | "reason_required" }
  | { outcome: "unexpected_error"; error: string };
