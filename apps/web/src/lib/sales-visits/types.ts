// =============================================================================
// Kunjungan Sales (Gate 3E-D5-B) — workflow web dua-fase yang mengkredit
// achievement CALL/EFFECTIVE_CALL governed existing (public.sales_kpi_*).
// Achievement TIDAK PERNAH diinput/di-override manual lewat action ini --
// hanya lahir dari RPC start_sales_visit/complete_sales_visit.
// =============================================================================

export const VISIT_PURPOSES = [
  "OFFER_PRODUCT",
  "CHECK_STOCK",
  "COLLECTION",
  "HANDLE_COMPLAINT",
  "FOLLOW_UP",
  "RELATIONSHIP",
  "OTHER",
] as const;
export type VisitPurpose = (typeof VISIT_PURPOSES)[number];

export const VISIT_RESULTS = [
  "MET_STORE",
  "STORE_CLOSED",
  "PERSON_NOT_AVAILABLE",
  "ADDRESS_NOT_FOUND",
  "VISIT_CANCELLED",
  "OTHER",
] as const;
export type VisitResult = (typeof VISIT_RESULTS)[number];

export const VISIT_MET_WITH_OPTIONS = [
  "OWNER",
  "PURCHASING",
  "CASHIER",
  "EMPLOYEE",
  "OTHER",
] as const;
export type VisitMetWith = (typeof VISIT_MET_WITH_OPTIONS)[number];

export const VISIT_ACTIVITIES = [
  "OFFER_PRODUCT",
  "CHECK_STOCK",
  "EXPLAIN_PROMO",
  "COLLECT_PAYMENT",
  "HANDLE_COMPLAINT",
  "MARKET_INFO",
  "AGREE_FOLLOW_UP",
] as const;
export type VisitActivity = (typeof VISIT_ACTIVITIES)[number];

export type VisitStatus = "IN_PROGRESS" | "COMPLETED";

export interface SalesVisit {
  id: string;
  companyId: string;
  salespersonId: string;
  customerId: string;
  visitPurpose: VisitPurpose;
  planNotes: string | null;
  startLatitude: number;
  startLongitude: number;
  startedAt: string;
  status: VisitStatus;
  visitResult: VisitResult | null;
  metWith: VisitMetWith | null;
  metPersonName: string | null;
  activities: VisitActivity[];
  resultNotes: string | null;
  followUpNeeded: boolean;
  followUpPlan: string | null;
  followUpDate: string | null;
  photoUrl: string | null;
  endLatitude: number | null;
  endLongitude: number | null;
  completedAt: string | null;
  callId: string | null;
  createdAt: string;
  /** Diturunkan: true bila visitResult MET_STORE + metWith + minimal 1 aktivitas substantif. */
  isEffective: boolean;
  /** Nama & alamat toko -- untuk tampilan riwayat tanpa join tambahan di klien. */
  customerName?: string;
  customerAddress?: string | null;
}

export interface StartSalesVisitInput {
  companyId: string;
  actorId: string;
  customerId: string;
  visitPurpose: VisitPurpose;
  planNotes: string | null;
  startLatitude: number;
  startLongitude: number;
  idempotencyKey: string;
}

export type StartSalesVisitResult =
  | { outcome: "started"; visitId: string }
  | { outcome: "already_started"; visitId: string }
  | {
      outcome:
        | "forbidden"
        | "invalid_purpose"
        | "invalid_location"
        | "idempotency_key_required"
        | "customer_not_found"
        | "visit_already_active";
    }
  | { outcome: "unexpected_error"; error: string };

export interface CompleteSalesVisitInput {
  companyId: string;
  actorId: string;
  visitId: string;
  visitResult: VisitResult;
  metWith: VisitMetWith | null;
  metPersonName: string | null;
  activities: VisitActivity[];
  resultNotes: string;
  followUpNeeded: boolean;
  followUpPlan: string | null;
  followUpDate: string | null;
  photoUrl: string | null;
  endLatitude: number;
  endLongitude: number;
  idempotencyKey: string;
}

export type CompleteSalesVisitResult =
  | {
      outcome: "completed" | "already_recorded";
      visitId: string;
      callCredited: boolean;
      ecCredited: boolean;
    }
  | { outcome: "completed_cancelled" | "completed_no_active_period"; visitId: string }
  | {
      outcome:
        | "idempotency_key_required"
        | "forbidden"
        | "visit_not_found"
        | "already_completed"
        | "invalid_result"
        | "met_with_required"
        | "invalid_input"
        | "result_notes_required"
        | "follow_up_required"
        | "invalid_location"
        | "invalid_activity";
    }
  | { outcome: "unexpected_error"; error: string };
