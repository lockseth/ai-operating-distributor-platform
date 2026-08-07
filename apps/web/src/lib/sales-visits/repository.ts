import type { SupabaseClient } from "@supabase/supabase-js";
import { isEffectiveVisit } from "./service";
import type {
  CompleteSalesVisitInput,
  CompleteSalesVisitResult,
  SalesVisit,
  StartSalesVisitInput,
  StartSalesVisitResult,
  VisitActivity,
  VisitMetWith,
  VisitPurpose,
  VisitResult,
} from "./types";

export interface SalesVisitsRepository {
  startVisit(input: StartSalesVisitInput): Promise<StartSalesVisitResult>;
  completeVisit(
    input: CompleteSalesVisitInput,
  ): Promise<CompleteSalesVisitResult>;
  getActiveVisit(
    companyId: string,
    salespersonId: string,
  ): Promise<SalesVisit | null>;
  listVisits(
    companyId: string,
    salespersonId: string,
    limit: number,
  ): Promise<SalesVisit[]>;
}

function firstRow<T>(data: unknown): T | null {
  return ((data ?? []) as T[])[0] ?? null;
}

interface VisitRow {
  id: string;
  company_id: string;
  salesperson_id: string;
  customer_id: string;
  visit_purpose: string;
  plan_notes: string | null;
  start_latitude: number;
  start_longitude: number;
  started_at: string;
  status: string;
  visit_result: string | null;
  met_with: string | null;
  met_person_name: string | null;
  activities: string[];
  result_notes: string | null;
  follow_up_needed: boolean;
  follow_up_plan: string | null;
  follow_up_date: string | null;
  photo_url: string | null;
  end_latitude: number | null;
  end_longitude: number | null;
  completed_at: string | null;
  call_id: string | null;
  created_at: string;
  customers?: { name: string; address: string | null } | { name: string; address: string | null }[] | null;
}

function mapVisitRow(row: VisitRow): SalesVisit {
  const customer = Array.isArray(row.customers) ? row.customers[0] : row.customers;
  const activities = (row.activities ?? []) as VisitActivity[];
  const visitResult = row.visit_result as VisitResult | null;
  const metWith = row.met_with as VisitMetWith | null;
  return {
    id: row.id,
    companyId: row.company_id,
    salespersonId: row.salesperson_id,
    customerId: row.customer_id,
    visitPurpose: row.visit_purpose as VisitPurpose,
    planNotes: row.plan_notes,
    startLatitude: row.start_latitude,
    startLongitude: row.start_longitude,
    startedAt: row.started_at,
    status: row.status as SalesVisit["status"],
    visitResult,
    metWith,
    metPersonName: row.met_person_name,
    activities,
    resultNotes: row.result_notes,
    followUpNeeded: row.follow_up_needed,
    followUpPlan: row.follow_up_plan,
    followUpDate: row.follow_up_date,
    photoUrl: row.photo_url,
    endLatitude: row.end_latitude,
    endLongitude: row.end_longitude,
    completedAt: row.completed_at,
    callId: row.call_id,
    createdAt: row.created_at,
    isEffective: visitResult ? isEffectiveVisit(visitResult, metWith, activities) : false,
    customerName: customer?.name,
    customerAddress: customer?.address ?? null,
  };
}

const VISIT_SELECT =
  "id, company_id, salesperson_id, customer_id, visit_purpose, plan_notes, start_latitude, start_longitude, started_at, status, visit_result, met_with, met_person_name, activities, result_notes, follow_up_needed, follow_up_plan, follow_up_date, photo_url, end_latitude, end_longitude, completed_at, call_id, created_at, customers(name, address)";

export class SupabaseSalesVisitsRepository implements SalesVisitsRepository {
  constructor(private readonly client: SupabaseClient) {}

  async startVisit(input: StartSalesVisitInput): Promise<StartSalesVisitResult> {
    const { data, error } = await this.client.rpc("start_sales_visit", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_customer_id: input.customerId,
      p_visit_purpose: input.visitPurpose,
      p_plan_notes: input.planNotes,
      p_start_latitude: input.startLatitude,
      p_start_longitude: input.startLongitude,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{ result_outcome: string; result_visit_id: string | null }>(
      data,
    );
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };
    if (
      (row.result_outcome === "started" || row.result_outcome === "already_started") &&
      row.result_visit_id
    ) {
      return { outcome: row.result_outcome, visitId: row.result_visit_id };
    }
    if (
      row.result_outcome === "forbidden" ||
      row.result_outcome === "invalid_purpose" ||
      row.result_outcome === "invalid_location" ||
      row.result_outcome === "idempotency_key_required" ||
      row.result_outcome === "customer_not_found" ||
      row.result_outcome === "visit_already_active"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async completeVisit(
    input: CompleteSalesVisitInput,
  ): Promise<CompleteSalesVisitResult> {
    const { data, error } = await this.client.rpc("complete_sales_visit", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_visit_id: input.visitId,
      p_visit_result: input.visitResult,
      p_met_with: input.metWith,
      p_met_person_name: input.metPersonName,
      p_activities: input.activities,
      p_result_notes: input.resultNotes,
      p_follow_up_needed: input.followUpNeeded,
      p_follow_up_plan: input.followUpPlan,
      p_follow_up_date: input.followUpDate,
      p_photo_url: input.photoUrl,
      p_end_latitude: input.endLatitude,
      p_end_longitude: input.endLongitude,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = firstRow<{
      result_outcome: string;
      result_visit_id: string | null;
      result_call_credited: boolean | null;
      result_ec_credited: boolean | null;
    }>(data);
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    if (
      (row.result_outcome === "completed" || row.result_outcome === "already_recorded") &&
      row.result_visit_id
    ) {
      return {
        outcome: row.result_outcome,
        visitId: row.result_visit_id,
        callCredited: Boolean(row.result_call_credited),
        ecCredited: Boolean(row.result_ec_credited),
      };
    }
    if (
      (row.result_outcome === "completed_cancelled" ||
        row.result_outcome === "completed_no_active_period") &&
      row.result_visit_id
    ) {
      return { outcome: row.result_outcome, visitId: row.result_visit_id };
    }
    if (
      row.result_outcome === "idempotency_key_required" ||
      row.result_outcome === "forbidden" ||
      row.result_outcome === "visit_not_found" ||
      row.result_outcome === "already_completed" ||
      row.result_outcome === "invalid_result" ||
      row.result_outcome === "met_with_required" ||
      row.result_outcome === "invalid_input" ||
      row.result_outcome === "result_notes_required" ||
      row.result_outcome === "follow_up_required" ||
      row.result_outcome === "invalid_location" ||
      row.result_outcome === "invalid_activity"
    ) {
      return { outcome: row.result_outcome };
    }
    return {
      outcome: "unexpected_error",
      error: `unknown outcome: ${row.result_outcome}`,
    };
  }

  async getActiveVisit(
    companyId: string,
    salespersonId: string,
  ): Promise<SalesVisit | null> {
    const { data } = await this.client
      .from("sales_visits")
      .select(VISIT_SELECT)
      .eq("company_id", companyId)
      .eq("salesperson_id", salespersonId)
      .eq("status", "IN_PROGRESS")
      .maybeSingle();
    if (!data) return null;
    return mapVisitRow(data as unknown as VisitRow);
  }

  async listVisits(
    companyId: string,
    salespersonId: string,
    limit: number,
  ): Promise<SalesVisit[]> {
    const { data } = await this.client
      .from("sales_visits")
      .select(VISIT_SELECT)
      .eq("company_id", companyId)
      .eq("salesperson_id", salespersonId)
      .order("started_at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as unknown as VisitRow[]).map(mapVisitRow);
  }
}
