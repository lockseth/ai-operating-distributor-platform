const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function isValidBusinessDate(value: string): boolean {
  return isRealIsoDate(value);
}

/** Idempotency key deterministik -- paralel dengan `morning_brief:{salespersonId}:{businessDate}`. */
export function dailySessionIdempotencyKey(
  salesmanId: string,
  businessDate: string,
): string {
  return `daily_session:${salesmanId}:${businessDate}`;
}

export function validateStartDailySessionInput(input: {
  businessDate: string;
  idempotencyKey: string;
}): "invalid_date" | "idempotency_key_required" | null {
  if (!isRealIsoDate(input.businessDate)) return "invalid_date";
  if (input.idempotencyKey.trim().length === 0) return "idempotency_key_required";
  return null;
}

export function validateReopenDailySessionInput(input: {
  reason: string;
}): "reason_required" | null {
  if (input.reason.trim().length < 3) return "reason_required";
  return null;
}
