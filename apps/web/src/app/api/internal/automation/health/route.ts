// =============================================================================
// Internal Automation API -- health/readiness. Tidak pernah menampilkan
// secret/credential -- hanya angka agregat dan status boolean.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-health:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!credential.scope.includes("automation.health")) {
      return NextResponse.json({ error: "Forbidden: credential missing automation.health scope" }, { status: 403 });
    }

    const snapshot = await repository.getHealthSnapshot(credential.companyId);

    // AUTOMATION_DRY_RUN default TRUE (aman) -- hanya "false" eksplisit yang
    // mengizinkan pengiriman Telegram nyata lewat /dispatch. Tidak pernah
    // menampilkan token/bot token itu sendiri, hanya mode-nya.
    const dryRun = process.env.AUTOMATION_DRY_RUN !== "false";

    const appHealthy = true; // endpoint ini merespons -> aplikasi hidup
    // n8nReachable === false berarti heartbeat PERNAH dipakai tapi sudah
    // basi (n8n mati/unreachable) -- degradasi nyata. null berarti
    // heartbeat belum pernah dipakai tenant ini -- tidak menurunkan status
    // (AODP tidak bergantung pada n8n untuk dianggap "healthy").
    const overallStatus =
      appHealthy && snapshot.dbHealthy && snapshot.n8nPollingHealthy && snapshot.deadLetterCount === 0 && snapshot.n8nReachable !== false
        ? "healthy"
        : appHealthy && snapshot.dbHealthy
          ? "degraded"
          : "unhealthy";

    return NextResponse.json({
      status: overallStatus,
      app_healthy: appHealthy,
      db_healthy: snapshot.dbHealthy,
      n8n_polling_healthy: snapshot.n8nPollingHealthy,
      n8n: {
        last_heartbeat_at: snapshot.n8nLastHeartbeatAt,
        reachable: snapshot.n8nReachable,
      },
      provider_readiness: {
        telegram: dryRun ? "mock" : "live",
        whatsapp: "mock", // WhatsApp production sengaja tidak diimplementasikan phase ini
      },
      backlog: {
        pending: snapshot.pendingCount,
        retry_due: snapshot.retryBacklogCount,
        processing: snapshot.processingCount,
        stale_processing: snapshot.staleProcessingCount,
        dead_letter: snapshot.deadLetterCount,
      },
      sent_last_24h: snapshot.sentLast24h,
      last_claim_at: snapshot.lastClaimAt,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Internal Automation /health]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
