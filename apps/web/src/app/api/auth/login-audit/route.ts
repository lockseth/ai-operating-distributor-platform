import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

// 10 req/menit per IP — login events should be infrequent
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`login-audit:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const { data: profileData } = await supabase
      .from("users")
      .select("id, company_id")
      .eq("id", user.id)
      .maybeSingle();

    const profile = profileData as { id: string; company_id: string } | null;

    if (profile) {
      // Only accept known safe string field; discard everything else
      let userAgent: string | undefined;
      try {
        const body = await request.json() as Record<string, unknown>;
        if (typeof body.user_agent === "string" && body.user_agent.length <= 512) {
          userAgent = body.user_agent;
        }
      } catch {
        // Body is optional — ignore parse errors
      }

      await logAuditEvent({
        company_id:  profile.company_id,
        user_id:     profile.id,
        action:      "login",
        entity_type: "session",
        new_data: {
          provider:   "email",
          email:      user.email,
          user_agent: userAgent,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
