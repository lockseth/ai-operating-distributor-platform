// =============================================================================
// Internal Automation API -- laporkan kegagalan pengiriman. retryable=true
// -> RETRY (backoff) atau DEAD_LETTER (jika max_attempts habis). retryable=
// false -> FAILED langsung (error data, tidak akan pernah berhasil diulang).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import {
  isNonEmptyString,
  isUuid,
  resolveAutomationCredential,
  sanitizeAutomationError,
} from "@/lib/n8n-automation/service";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-fail:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as
      | { job_id?: unknown; error?: unknown; retryable?: unknown }
      | null;
    if (!body || !isUuid(body.job_id) || !isNonEmptyString(body.error)) {
      return NextResponse.json({ error: "job_id (UUID) and error are required" }, { status: 400 });
    }
    const retryable = body.retryable !== false; // default true (transient) kecuali eksplisit false

    const result = await repository.failJob({
      companyId: credential.companyId,
      credentialId: credential.id,
      jobId: body.job_id,
      error: sanitizeAutomationError(body.error),
      retryable,
    });

    switch (result.outcome) {
      case "forbidden":
        return NextResponse.json({ error: "Forbidden: credential missing automation.fail scope" }, { status: 403 });
      case "not_found":
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      case "invalid_state":
        return NextResponse.json({ error: "Job is not in PROCESSING state" }, { status: 409 });
      case "unexpected_error":
        console.error("[Internal Automation /fail]", (result as { error: string }).error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      case "failed":
      case "dead_letter":
      case "retry_scheduled":
        return NextResponse.json({ outcome: result.outcome, status: result.status });
    }
  } catch (err) {
    console.error("[Internal Automation /fail]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
