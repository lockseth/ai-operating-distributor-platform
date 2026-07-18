// =============================================================================
// Internal Automation API -- claim pending jobs.
//
// Autentikasi: Bearer token, pola SAMA dengan api/webhooks/n8n (lihat
// lib/integrations/n8n-inbound.ts) -- company_id SELALU di-resolve dari
// credential, TIDAK PERNAH dari body. Endpoint ini tidak bisa dipanggil
// anonymous (tanpa Authorization -> 401 sebelum operasi apa pun).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential, isNonEmptyString } from "@/lib/n8n-automation/service";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-claim:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const maxJobs =
      body && typeof body === "object" && typeof (body as { max_jobs?: unknown }).max_jobs === "number"
        ? (body as { max_jobs: number }).max_jobs
        : 5;
    const workerLabel =
      body && typeof body === "object" && isNonEmptyString((body as { worker_label?: unknown }).worker_label)
        ? (body as { worker_label: string }).worker_label
        : `worker-${ip}`;

    const result = await repository.claimJobs({
      companyId: credential.companyId,
      credentialId: credential.id,
      maxJobs,
      workerLabel,
    });

    switch (result.outcome) {
      case "forbidden":
        return NextResponse.json({ error: "Forbidden: credential missing automation.claim scope" }, { status: 403 });
      case "invalid_max_jobs":
        return NextResponse.json({ error: "max_jobs must be an integer between 1 and 50" }, { status: 400 });
      case "unexpected_error":
        console.error("[Internal Automation /claim]", result.error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      case "claimed":
        return NextResponse.json({
          jobs: result.jobs.map((j) => ({
            job_id: j.jobId,
            event_type: j.eventType,
            channel: j.channel,
            recipient_reference: j.recipientReference,
            payload: j.payload,
            attempt_count: j.attemptCount,
            max_attempts: j.maxAttempts,
          })),
        });
    }
  } catch (err) {
    console.error("[Internal Automation /claim]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
