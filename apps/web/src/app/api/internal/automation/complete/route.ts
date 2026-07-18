// =============================================================================
// Internal Automation API -- tandai job SENT. Idempotent (retry job_id yang
// sama pada baris yang sudah SENT -> already_completed, bukan error).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { isUuid, resolveAutomationCredential } from "@/lib/n8n-automation/service";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-complete:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as
      | { job_id?: unknown; provider_message_id?: unknown }
      | null;
    if (!body || !isUuid(body.job_id)) {
      return NextResponse.json({ error: "job_id (UUID) is required" }, { status: 400 });
    }

    const result = await repository.completeJob({
      companyId: credential.companyId,
      credentialId: credential.id,
      jobId: body.job_id,
      providerMessageId: typeof body.provider_message_id === "string" ? body.provider_message_id : null,
    });

    switch (result.outcome) {
      case "forbidden":
        return NextResponse.json({ error: "Forbidden: credential missing automation.complete scope" }, { status: 403 });
      case "not_found":
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      case "invalid_state":
        return NextResponse.json({ error: "Job is not in PROCESSING state" }, { status: 409 });
      case "unexpected_error":
        console.error("[Internal Automation /complete]", (result as { error: string }).error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      case "completed":
      case "already_completed":
        return NextResponse.json({ outcome: result.outcome });
    }
  } catch (err) {
    console.error("[Internal Automation /complete]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
