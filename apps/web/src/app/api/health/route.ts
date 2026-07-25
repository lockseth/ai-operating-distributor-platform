// =============================================================================
// Public infra liveness probe -- Gate 3A finding (Deployment readiness).
// SENGAJA TIDAK terautentikasi (beda dari /api/internal/automation/health
// yang business-scoped per tenant) supaya load balancer/orchestrator/uptime
// monitor bisa memeriksa "aplikasi hidup" tanpa credential. Tidak pernah
// menampilkan secret/nilai konfigurasi -- hanya status boolean + DB
// reachability agregat (bukan data tenant apa pun).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`health:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.success) return buildRateLimitResponse(rl.resetAt);

  let dbHealthy = false;
  try {
    const { error } = await getAdminClient().from("companies").select("id").limit(1);
    dbHealthy = !error;
  } catch {
    dbHealthy = false;
  }

  const status = dbHealthy ? "healthy" : "degraded";
  return NextResponse.json(
    { status, db_healthy: dbHealthy, checked_at: new Date().toISOString() },
    { status: dbHealthy ? 200 : 503 },
  );
}
