import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateReopenDailySessionInput,
  validateStartDailySessionInput,
} from "./service";
import type {
  CloseDailySessionInput,
  CloseDailySessionResult,
  DailySession,
  DailySessionStatus,
  ReopenDailySessionInput,
  ReopenDailySessionResult,
  StartDailySessionInput,
  StartDailySessionResult,
} from "./types";

export interface DailySessionRepository {
  start(input: StartDailySessionInput): Promise<StartDailySessionResult>;
  close(input: CloseDailySessionInput): Promise<CloseDailySessionResult>;
  reopen(input: ReopenDailySessionInput): Promise<ReopenDailySessionResult>;
  /** Sesi salesman untuk business_date tertentu, atau null jika NOT_STARTED. */
  findForBusinessDate(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<DailySession | null>;
}

function firstRow<T>(data: unknown): T | null {
  return ((data ?? []) as T[])[0] ?? null;
}

export class SupabaseDailySessionRepository implements DailySessionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async start(input: StartDailySessionInput): Promise<StartDailySessionResult> {
    const { data, error } = await this.client.rpc("start_daily_session", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_salesman_id: input.salesmanId,
      p_business_date: input.businessDate,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_session_id: string | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      (row.result_outcome === "started" ||
        row.result_outcome === "already_started") &&
      row.result_session_id
    ) {
      return { outcome: row.result_outcome, sessionId: row.result_session_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_date" ||
      row.result_outcome === "idempotency_key_required" ||
      row.result_outcome === "salesperson_not_eligible"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async close(input: CloseDailySessionInput): Promise<CloseDailySessionResult> {
    const { data, error } = await this.client.rpc("close_daily_session", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_session_id: input.sessionId,
      p_close_summary: input.closeSummary ?? null,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "closed" ||
      row.result_outcome === "already_closed" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "session_not_found" ||
      row.result_outcome === "blocked_open_visits" ||
      row.result_outcome === "blocked_open_deliveries"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async reopen(input: ReopenDailySessionInput): Promise<ReopenDailySessionResult> {
    const { data, error } = await this.client.rpc("reopen_daily_session", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_session_id: input.sessionId,
      p_reason: input.reason,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      row.result_outcome === "reopened" ||
      row.result_outcome === "already_active" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "session_not_found" ||
      row.result_outcome === "reason_required"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async findForBusinessDate(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<DailySession | null> {
    const { data } = await this.client
      .from("salesman_daily_sessions")
      .select(
        "id, company_id, salesman_id, business_date, status, started_at, started_by, closed_at, closed_by, close_summary",
      )
      .eq("company_id", companyId)
      .eq("salesman_id", salesmanId)
      .eq("business_date", businessDate)
      .maybeSingle();
    if (!data) return null;
    return mapRow(
      data as {
        id: string;
        company_id: string;
        salesman_id: string;
        business_date: string;
        status: DailySessionStatus;
        started_at: string;
        started_by: string;
        closed_at: string | null;
        closed_by: string | null;
        close_summary: unknown;
      },
    );
  }
}

function mapRow(row: {
  id: string;
  company_id: string;
  salesman_id: string;
  business_date: string;
  status: DailySessionStatus;
  started_at: string;
  started_by: string;
  closed_at: string | null;
  closed_by: string | null;
  close_summary: unknown;
}): DailySession {
  return {
    id: row.id,
    companyId: row.company_id,
    salesmanId: row.salesman_id,
    businessDate: row.business_date,
    status: row.status,
    startedAt: row.started_at,
    startedBy: row.started_by,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closeSummary: row.close_summary,
  };
}

interface ActorSeed {
  companyId: string;
  role: "owner" | "manager" | "super_admin" | "sales" | "admin";
  active: boolean;
}

interface SalesmanSeed {
  companyId: string;
  active: boolean;
}

interface SessionRecord {
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
  idempotencyKey: string;
}

export class InMemoryDailySessionRepository implements DailySessionRepository {
  private readonly actors = new Map<string, ActorSeed>();
  private readonly salesmen = new Map<string, SalesmanSeed>();
  private readonly sessions: SessionRecord[] = [];
  private sequence = 0;

  seedActor(actorId: string, companyId: string, role: ActorSeed["role"], active = true): void {
    this.actors.set(actorId, { companyId, role, active });
  }

  seedSalesman(salesmanId: string, companyId: string, active = true): void {
    this.salesmen.set(salesmanId, { companyId, active });
  }

  getSessions(companyId: string): DailySession[] {
    return this.sessions
      .filter((session) => session.companyId === companyId)
      .map((row) => toPublicSession(row));
  }

  private nextId(): string {
    this.sequence += 1;
    return `session-${this.sequence}`;
  }

  private canActOnBehalfOf(actorId: string, companyId: string, salesmanId: string): boolean {
    if (actorId === salesmanId) {
      const actor = this.actors.get(actorId);
      return Boolean(actor?.active && actor.companyId === companyId);
    }
    const actor = this.actors.get(actorId);
    return Boolean(
      actor?.active &&
        actor.companyId === companyId &&
        (actor.role === "owner" || actor.role === "manager" || actor.role === "super_admin"),
    );
  }

  private canManage(actorId: string, companyId: string): boolean {
    const actor = this.actors.get(actorId);
    return Boolean(
      actor?.active &&
        actor.companyId === companyId &&
        (actor.role === "owner" || actor.role === "manager" || actor.role === "super_admin"),
    );
  }

  async start(input: StartDailySessionInput): Promise<StartDailySessionResult> {
    if (!this.canActOnBehalfOf(input.actorId, input.companyId, input.salesmanId)) {
      return { outcome: "forbidden" };
    }
    const validation = validateStartDailySessionInput(input);
    if (validation) return { outcome: validation };

    const salesman = this.salesmen.get(input.salesmanId);
    if (!salesman?.active || salesman.companyId !== input.companyId) {
      return { outcome: "salesperson_not_eligible" };
    }

    const existing = this.sessions.find(
      (session) =>
        session.companyId === input.companyId &&
        session.salesmanId === input.salesmanId &&
        session.businessDate === input.businessDate,
    );
    if (existing) return { outcome: "already_started", sessionId: existing.id };

    const id = this.nextId();
    this.sessions.push({
      id,
      companyId: input.companyId,
      salesmanId: input.salesmanId,
      businessDate: input.businessDate,
      status: "ACTIVE",
      startedAt: new Date().toISOString(),
      startedBy: input.actorId,
      closedAt: null,
      closedBy: null,
      closeSummary: null,
      idempotencyKey: input.idempotencyKey,
    });
    return { outcome: "started", sessionId: id };
  }

  async close(input: CloseDailySessionInput): Promise<CloseDailySessionResult> {
    const session = this.sessions.find(
      (candidate) => candidate.id === input.sessionId && candidate.companyId === input.companyId,
    );
    if (!session) return { outcome: "session_not_found" };
    if (!this.canActOnBehalfOf(input.actorId, input.companyId, session.salesmanId)) {
      return { outcome: "forbidden" };
    }
    if (session.status === "CLOSED") return { outcome: "already_closed" };

    session.status = "CLOSED";
    session.closedAt = new Date().toISOString();
    session.closedBy = input.actorId;
    session.closeSummary = input.closeSummary ?? null;
    return { outcome: "closed" };
  }

  async reopen(input: ReopenDailySessionInput): Promise<ReopenDailySessionResult> {
    if (!this.canManage(input.actorId, input.companyId)) return { outcome: "forbidden" };
    const validation = validateReopenDailySessionInput(input);
    if (validation) return { outcome: validation };

    const session = this.sessions.find(
      (candidate) => candidate.id === input.sessionId && candidate.companyId === input.companyId,
    );
    if (!session) return { outcome: "session_not_found" };
    if (session.status === "ACTIVE") return { outcome: "already_active" };

    session.status = "ACTIVE";
    session.closedAt = null;
    session.closedBy = null;
    session.closeSummary = null;
    return { outcome: "reopened" };
  }

  async findForBusinessDate(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<DailySession | null> {
    const session = this.sessions.find(
      (candidate) =>
        candidate.companyId === companyId &&
        candidate.salesmanId === salesmanId &&
        candidate.businessDate === businessDate,
    );
    return session ? toPublicSession(session) : null;
  }
}

function toPublicSession(row: SessionRecord): DailySession {
  return {
    id: row.id,
    companyId: row.companyId,
    salesmanId: row.salesmanId,
    businessDate: row.businessDate,
    status: row.status,
    startedAt: row.startedAt,
    startedBy: row.startedBy,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    closeSummary: row.closeSummary,
  };
}
