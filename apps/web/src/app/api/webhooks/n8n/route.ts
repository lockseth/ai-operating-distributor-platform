// =============================================================================
// Inbound Webhook dari n8n → AODP
// n8n dapat mengirim event ke sini untuk memicu aksi/log di AODP.
//
// Autentikasi: Bearer token per-tenant (lihat lib/integrations/n8n-inbound.ts).
// company_id SELALU di-resolve server-side dari credential yang dikirim —
// TIDAK PERNAH dipercaya dari field company_id di payload. Global shared
// secret (skema HMAC lama) sudah dihapus — lihat docs/architecture/
// TELEGRAM_SALES_ORDER_ENTRY.md bagian "Kredensial Inbound n8n".
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { processN8nInboundEvent, SupabaseN8nInboundRepository } from "@/lib/integrations/n8n-inbound";

// 60 req/menit per IP untuk mencegah flood dari n8n yang misconfigured
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`n8n:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const rawBody = await request.text();
    const authHeader = request.headers.get("Authorization");

    const supabase = getAdminClient();
    const repository = new SupabaseN8nInboundRepository(supabase);
    const result = await processN8nInboundEvent(authHeader, rawBody, repository);

    switch (result.outcome) {
      case "unauthorized":
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      case "invalid_body":
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
      case "tenant_mismatch":
        return NextResponse.json({ error: "Forbidden: tenant mismatch" }, { status: 403 });
      case "scope_denied":
        return NextResponse.json({ error: "Forbidden: event type not permitted for this credential" }, { status: 403 });
      case "duplicate_event":
        return NextResponse.json({ received: true, duplicate: true });
      case "accepted":
        return NextResponse.json({
          received: true,
          event_type: result.eventType,
          timestamp: new Date().toISOString(),
        });
      default:
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  } catch (err) {
    console.error("[Webhook /n8n]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
