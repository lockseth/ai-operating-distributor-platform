// =============================================================================
// n8n Automation & Orchestration Foundation -- pure helpers (tanpa I/O).
// =============================================================================

import { extractBearerToken, hashN8nCredential } from "@/lib/integrations/n8n-inbound";
import type { AutomationRepository, ResolvedAutomationCredential } from "./repository";

export { extractBearerToken, hashN8nCredential };

/**
 * Resolusi credential dari header Authorization -- SATU-SATUNYA jalur yang
 * boleh dipakai internal automation API. company_id SELALU berasal dari
 * credential yang di-resolve server-side (pola sama seperti n8n-inbound),
 * TIDAK PERNAH dari body/query request.
 */
export async function resolveAutomationCredential(
  authorizationHeader: string | null,
  repository: AutomationRepository,
): Promise<ResolvedAutomationCredential | null> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return null;
  return repository.resolveCredential(hashN8nCredential(token));
}

/**
 * Sanitasi error provider SEBELUM dikirim ke fail_automation_job -- lapis
 * pertama (RPC punya lapis kedua sebagai defense-in-depth, lihat migration
 * 20260807000001). Menghapus pola mirip Bearer token/Authorization header
 * dan memotong panjang supaya last_error tidak pernah membocorkan credential
 * meski provider secara keliru meng-echo header request di pesan error-nya.
 */
export function sanitizeAutomationError(raw: string): string {
  const sanitized = raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, (match) =>
      // String panjang tak berspasi (32+ char) yang menyerupai token/hash
      // mentah -- redact preventif, bukan hanya pola header eksplisit.
      match.length >= 32 ? "[redacted-token-like]" : match,
    );
  return sanitized.slice(0, 500);
}

/** Backoff eksponensial (menit), cap 60 menit -- cermin dari fail_automation_job di SQL. */
export function computeBackoffMinutes(attemptCount: number): number {
  return Math.min(2 ** attemptCount, 60);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
