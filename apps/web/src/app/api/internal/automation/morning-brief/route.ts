// =============================================================================
// Internal Automation API -- generate Morning Brief. Membuat SATU outbox job
// PENDING per salesman aktif+Telegram valid, idempotent per (salesperson,
// business date Asia/Jakarta). Konten SELALU dari lib/sales-kpi/* (achievement
// projection + calibration baseline) -- endpoint ini TIDAK menghitung Call/
// EC/achievement sendiri, hanya memanggil service AODP lalu merangkai teks
// lewat presenter (lib/n8n-automation/morning-brief.ts).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";
import { SupabaseSalesmanDirectory } from "@/lib/n8n-automation/salesman-directory";
import { buildMorningBrief, morningBriefIdempotencyKey } from "@/lib/n8n-automation/morning-brief";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { SupabaseSalesKpiRepository } from "@/lib/sales-kpi/repository";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const REQUIRED_SCOPE = "automation.morning_brief.generate";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-morning-brief:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const admin = getAdminClient();
    const repository = new SupabaseAutomationRepository(admin);
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!credential.scope.includes(REQUIRED_SCOPE)) {
      return NextResponse.json({ error: `Forbidden: credential missing ${REQUIRED_SCOPE} scope` }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as { business_date?: unknown };
    const businessDate =
      typeof body.business_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.business_date)
        ? body.business_date
        : businessDateJakarta();

    const { data: companyRow } = await admin
      .from("companies")
      .select("name")
      .eq("id", credential.companyId)
      .maybeSingle();
    const tenantName = (companyRow as { name: string } | null)?.name ?? "AODP";

    const salesKpiRepository = new SupabaseSalesKpiRepository(admin);
    const activePeriod = await salesKpiRepository.findActivePeriod(credential.companyId);

    const directory = new SupabaseSalesmanDirectory(admin);
    const recipients = await directory.listEligibleMorningBriefRecipients(credential.companyId);

    let created = 0;
    let skipped = 0;
    const results: Record<string, unknown>[] = [];

    for (const recipient of recipients) {
      let projection = null;
      let baseline = null;
      if (activePeriod) {
        const projectionResult = await salesKpiRepository.getAchievementProjection({
          companyId: credential.companyId,
          actorId: credential.id,
          periodId: activePeriod.id,
          salespersonId: recipient.userId,
        });
        projection = projectionResult.outcome === "ok" ? projectionResult.projection : null;

        const baselineResult = await salesKpiRepository.getCalibrationBaseline({
          companyId: credential.companyId,
          actorId: credential.id,
          periodId: activePeriod.id,
          salespersonId: recipient.userId,
        });
        baseline = baselineResult.outcome === "ok" ? baselineResult.baseline : null;
      }

      const content = buildMorningBrief({
        tenantName,
        salesmanFullName: recipient.fullName,
        coverageAreas: recipient.coverageAreas,
        businessDate,
        activePeriod,
        projection,
        baseline,
      });

      const enqueueResult = await repository.enqueueJob({
        companyId: credential.companyId,
        credentialId: credential.id,
        requiredScope: REQUIRED_SCOPE,
        eventType: "MORNING_BRIEF",
        channel: "telegram",
        recipientUserId: recipient.userId,
        recipientReference: recipient.telegramChatId,
        payload: { text: content.text, ...content.structured },
        idempotencyKey: morningBriefIdempotencyKey(recipient.userId, businessDate),
      });

      if (enqueueResult.outcome === "enqueued") created += 1;
      else if (enqueueResult.outcome === "already_exists") skipped += 1;
      results.push({ salesman: recipient.fullName, outcome: enqueueResult.outcome });
    }

    return NextResponse.json({
      business_date: businessDate,
      eligible_recipients: recipients.length,
      created,
      skipped,
      results,
    });
  } catch (err) {
    console.error("[Internal Automation /morning-brief]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
