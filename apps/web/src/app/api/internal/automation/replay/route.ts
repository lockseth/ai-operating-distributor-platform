// =============================================================================
// Internal Automation API -- controlled replay (dipicu credential n8n, mis.
// workflow aodp-dead-letter-monitor). Replay dari Owner lewat dashboard
// memakai server action terpisah (lib/n8n-automation/actions.ts) dengan
// actor manusia, BUKAN endpoint ini -- keduanya bermuara ke RPC yang sama
// (replay_automation_job) sehingga aturan tenant-scoping identik.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { isNonEmptyString, isUuid, resolveAutomationCredential } from "@/lib/n8n-automation/service";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-replay:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => null)) as
      | { job_id?: unknown; reason?: unknown }
      | null;
    if (!body || !isUuid(body.job_id) || !isNonEmptyString(body.reason)) {
      return NextResponse.json({ error: "job_id (UUID) and reason are required" }, { status: 400 });
    }

    const result = await repository.replayJob({
      companyId: credential.companyId,
      actorId: null,
      credentialId: credential.id,
      jobId: body.job_id,
      reason: body.reason,
    });

    switch (result.outcome) {
      case "forbidden":
        return NextResponse.json({ error: "Forbidden: credential missing automation.replay scope" }, { status: 403 });
      case "not_found":
        return NextResponse.json({ error: "Job not found" }, { status: 404 });
      case "invalid_state":
        return NextResponse.json({ error: "Job is not DEAD_LETTER/FAILED" }, { status: 409 });
      case "reason_required":
        return NextResponse.json({ error: "reason must be at least 3 characters" }, { status: 400 });
      case "unexpected_error":
        console.error("[Internal Automation /replay]", (result as { error: string }).error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      case "replayed":
        return NextResponse.json({ outcome: "replayed" });
    }
  } catch (err) {
    console.error("[Internal Automation /replay]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
