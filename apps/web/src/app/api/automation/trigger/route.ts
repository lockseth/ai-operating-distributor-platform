// =============================================================================
// POST /api/automation/trigger
// Memicu automation event secara manual atau dari scheduled task.
// =============================================================================

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { processAutomationEvent } from "@/lib/automation/engine";
import type { AutomationTriggerType } from "@/lib/automation/types";
import { checkRateLimit, buildRateLimitResponse } from "@/lib/rate-limit";

// 30 req/menit per company
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const VALID_TRIGGER_TYPES: AutomationTriggerType[] = [
  "customer_dormant",
  "churn_risk",
  "repeat_order_due",
  "large_order",
  "new_order",
  "low_stock",
  "payment_overdue",
  "new_customer",
  "scheduled_daily",
  "scheduled_weekly",
  "manual",
];

interface TriggerRequest {
  trigger_type: AutomationTriggerType;
  data?: Record<string, unknown>;
}

export async function POST(request: Request) {
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

    // Rate limit per company
    const rl = checkRateLimit(`automation-trigger:${companyId}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    // Parse and validate body
    let body: TriggerRequest;
    try {
      body = await request.json() as TriggerRequest;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.trigger_type || typeof body.trigger_type !== "string") {
      return NextResponse.json({ error: "trigger_type is required" }, { status: 400 });
    }

    if (!VALID_TRIGGER_TYPES.includes(body.trigger_type)) {
      return NextResponse.json(
        { error: `Invalid trigger_type. Must be one of: ${VALID_TRIGGER_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    if (body.data !== undefined && (typeof body.data !== "object" || Array.isArray(body.data))) {
      return NextResponse.json({ error: "data must be a JSON object" }, { status: 400 });
    }

    const results = await processAutomationEvent({
      trigger_type: body.trigger_type,
      company_id:   companyId,
      data:         body.data ?? {},
      fired_at:     new Date().toISOString(),
    });

    return NextResponse.json({
      triggered:       true,
      trigger_type:    body.trigger_type,
      rules_processed: results.length,
      results,
    });
  } catch (err) {
    // Only log unexpected errors — don't surface internals to client
    console.error("[API /automation/trigger]", err);
    return NextResponse.json({ error: "Failed to trigger automation" }, { status: 500 });
  }
}

