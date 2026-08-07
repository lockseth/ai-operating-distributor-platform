// Validasi murni (client & server) -- mencerminkan CHECK constraint RPC
// start_sales_visit/complete_sales_visit (migration 20261001000001) supaya
// UI bisa memberi feedback cepat sebelum roundtrip RPC. RPC tetap sumber
// kebenaran/enforcement akhir -- validasi di sini adalah UX, bukan security
// boundary.

import {
  VISIT_ACTIVITIES,
  VISIT_MET_WITH_OPTIONS,
  VISIT_PURPOSES,
  VISIT_RESULTS,
  type VisitActivity,
  type VisitMetWith,
  type VisitPurpose,
  type VisitResult,
} from "./types";

export function isVisitPurpose(value: string): value is VisitPurpose {
  return (VISIT_PURPOSES as readonly string[]).includes(value);
}

export function isVisitResult(value: string): value is VisitResult {
  return (VISIT_RESULTS as readonly string[]).includes(value);
}

export function isVisitMetWith(value: string): value is VisitMetWith {
  return (VISIT_MET_WITH_OPTIONS as readonly string[]).includes(value);
}

export function isVisitActivity(value: string): value is VisitActivity {
  return (VISIT_ACTIVITIES as readonly string[]).includes(value);
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

export interface StartVisitFormInput {
  customerId: string;
  visitPurpose: string;
  planNotes: string;
  startLatitude: number | null;
  startLongitude: number | null;
}

export type StartVisitValidationError =
  | "customer_required"
  | "invalid_purpose"
  | "invalid_location";

export function validateStartVisitInput(
  input: StartVisitFormInput,
): StartVisitValidationError | null {
  if (!input.customerId) return "customer_required";
  if (!isVisitPurpose(input.visitPurpose)) return "invalid_purpose";
  if (
    input.startLatitude === null ||
    input.startLongitude === null ||
    !isValidLatitude(input.startLatitude) ||
    !isValidLongitude(input.startLongitude)
  ) {
    return "invalid_location";
  }
  return null;
}

export interface CompleteVisitFormInput {
  visitResult: string;
  metWith: string | null;
  activities: string[];
  resultNotes: string;
  followUpNeeded: boolean;
  followUpPlan: string | null;
  followUpDate: string | null;
  endLatitude: number | null;
  endLongitude: number | null;
}

export type CompleteVisitValidationError =
  | "invalid_result"
  | "met_with_required"
  | "invalid_activity"
  | "result_notes_required"
  | "follow_up_required"
  | "invalid_location";

export function validateCompleteVisitInput(
  input: CompleteVisitFormInput,
): CompleteVisitValidationError | null {
  if (!isVisitResult(input.visitResult)) return "invalid_result";
  if (input.visitResult === "MET_STORE") {
    if (!input.metWith || !isVisitMetWith(input.metWith)) {
      return "met_with_required";
    }
  }
  for (const activity of input.activities) {
    if (!isVisitActivity(activity)) return "invalid_activity";
  }
  if (!input.resultNotes || input.resultNotes.trim().length < 3) {
    return "result_notes_required";
  }
  if (input.followUpNeeded) {
    if (
      !input.followUpPlan ||
      input.followUpPlan.trim().length < 3 ||
      !input.followUpDate
    ) {
      return "follow_up_required";
    }
  }
  if (
    input.endLatitude === null ||
    input.endLongitude === null ||
    !isValidLatitude(input.endLatitude) ||
    !isValidLongitude(input.endLongitude)
  ) {
    return "invalid_location";
  }
  return null;
}

/** Efektif = bertemu pihak toko + minimal satu aktivitas substantif dipilih (matriks CALL/EC gate 3E-D5-B). */
export function isEffectiveVisit(
  visitResult: VisitResult,
  metWith: VisitMetWith | null,
  activities: VisitActivity[],
): boolean {
  return visitResult === "MET_STORE" && metWith !== null && activities.length > 0;
}
