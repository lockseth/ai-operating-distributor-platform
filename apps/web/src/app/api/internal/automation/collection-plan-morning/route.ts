// =============================================================================
// Internal Automation API -- generate Rencana Penagihan Pagi untuk Owner.
// Fase B redesain Laporan Sales varian PAGI (Gate P4.12): "toko yang mau
// ditagih" hari itu -- overdue H+1 dan/atau janji bayar H+1 (definisi
// Founder 2026-08-22). WhatsApp production TIDAK diimplementasikan phase
// ini -- job selalu channel 'whatsapp' tapi dispatch selalu dry-run (lihat
// /dispatch route), hasil hanya structured preview yang bisa diaudit di
// automation_outbox.payload.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";
import { SupabaseSalesmanDirectory } from "@/lib/n8n-automation/salesman-directory";
import {
  buildCollectionPlanMorning,
  collectionPlanMorningIdempotencyKey,
} from "@/lib/n8n-automation/collection-plan-morning";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { getCollectionPlanBySalesperson } from "@/lib/finance/queries";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const REQUIRED_SCOPE = "automation.collection_plan.generate";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-collection-plan-morning:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
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

    const { data: ownerRoleRows } = await admin
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", credential.companyId);
    const owner = ((ownerRoleRows ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean } | null;
      role: { name: string } | null;
    }[]).find((r) => r.role?.name === "owner" && r.user?.is_active === true)?.user;

    if (!owner) {
      return NextResponse.json({ error: "No active owner found for tenant" }, { status: 422 });
    }

    const directory = new SupabaseSalesmanDirectory(admin);
    const recipients = await directory.listEligibleMorningBriefRecipients(credential.companyId);

    const planBySalesperson = await getCollectionPlanBySalesperson(credential.companyId, businessDate, admin);

    const lines = recipients.map((recipient) => ({
      salesmanFullName: recipient.fullName,
      entries: planBySalesperson.get(recipient.userId) ?? [],
    }));

    const content = buildCollectionPlanMorning({ tenantName, businessDate, lines });

    const enqueueResult = await repository.enqueueJob({
      companyId: credential.companyId,
      credentialId: credential.id,
      requiredScope: REQUIRED_SCOPE,
      eventType: "COLLECTION_PLAN_MORNING",
      channel: "whatsapp",
      recipientUserId: owner.id,
      recipientReference: `owner:${owner.id}`,
      payload: { text: content.text, ...content.structured },
      idempotencyKey: collectionPlanMorningIdempotencyKey(credential.companyId, businessDate),
    });

    return NextResponse.json({
      business_date: businessDate,
      salesmen_included: lines.length,
      outcome: enqueueResult.outcome,
      job_id: "jobId" in enqueueResult ? enqueueResult.jobId : null,
    });
  } catch (err) {
    console.error("[Internal Automation /collection-plan-morning]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
