import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAllInsights } from "@/lib/ai/insights-engine";
import { checkRateLimit, buildRateLimitResponse } from "@/lib/rate-limit";

// 20 req/menit per company — insight generation is expensive
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: profile } = await supabase
      .from("users")
      .select("company_id")
      .eq("id", user.id)
      .single();

    if (!profile?.company_id) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    // Rate limit per company (not per IP, so multiple users of the same tenant share quota)
    const companyId = profile.company_id as string;
    const rl = checkRateLimit(`ai-insights:${companyId}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    // Validate query param
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "true";

    const insights = await generateAllInsights(companyId, forceRefresh);
    return NextResponse.json(insights);
  } catch (err) {
    // Do not leak internal error details to client
    const isExpectedError = err instanceof Error && err.message.includes("credentials");
    if (!isExpectedError) console.error("[API /ai/insights]", err);
    return NextResponse.json({ error: "Failed to generate insights" }, { status: 500 });
  }
}
