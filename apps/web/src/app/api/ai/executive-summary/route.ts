import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateAllInsights } from "@/lib/ai/insights-engine";
import { checkRateLimit, buildRateLimitResponse } from "@/lib/rate-limit";

// 20 req/menit per company — shared quota with /api/ai/insights
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export async function GET() {
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

    const companyId = profile.company_id as string;
    const rl = checkRateLimit(`ai-insights:${companyId}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const insights = await generateAllInsights(companyId, false);
    return NextResponse.json(insights.executive_summary);
  } catch (err) {
    console.error("[API /ai/executive-summary]", err);
    return NextResponse.json({ error: "Failed to generate executive summary" }, { status: 500 });
  }
}
