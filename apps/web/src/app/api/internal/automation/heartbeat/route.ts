// =============================================================================
// Internal Automation API -- heartbeat. Bukti reachability n8n LANGSUNG
// (dipanggil oleh workflow aodp-health-check tiap jadwalnya) -- menggantikan
// heuristik lama yang hanya menebak dari aktivitas claim. AODP TIDAK
// bergantung pada endpoint ini: kalau n8n tidak pernah memanggilnya,
// n8nLastHeartbeatAt tetap NULL dan /health melaporkan "belum pernah
// terpakai" (bukan unhealthy) -- tidak ada alur order/transaksi yang
// membaca kolom ini.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential, isNonEmptyString } from "@/lib/n8n-automation/service";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const REQUIRED_SCOPE = "automation.health";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-heartbeat:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!credential.scope.includes(REQUIRED_SCOPE)) {
      return NextResponse.json({ error: `Forbidden: credential missing ${REQUIRED_SCOPE} scope` }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const workerLabel =
      body && typeof body === "object" && isNonEmptyString((body as { worker_label?: unknown }).worker_label)
        ? (body as { worker_label: string }).worker_label
        : `n8n-${ip}`;

    const result = await repository.recordHeartbeat({
      companyId: credential.companyId,
      credentialId: credential.id,
      workerLabel,
    });

    switch (result.outcome) {
      case "forbidden":
        return NextResponse.json({ error: `Forbidden: credential missing ${REQUIRED_SCOPE} scope` }, { status: 403 });
      case "unexpected_error":
        console.error("[Internal Automation /heartbeat]", result.error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
      case "recorded":
        return NextResponse.json({ recorded_at: result.heartbeatAt });
    }
  } catch (err) {
    console.error("[Internal Automation /heartbeat]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
