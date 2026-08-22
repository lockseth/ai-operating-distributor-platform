// =============================================================================
// Internal Automation API -- generate Rencana Penagihan Pagi untuk Owner.
// Fase B redesain Laporan Sales varian PAGI (Gate P4.12): "toko yang mau
// ditagih" hari itu -- overdue H+1 dan/atau janji bayar H+1 (definisi
// Founder 2026-08-22). Channel 'whatsapp', dikirim nyata lewat Bablast
// begitu BABLAST_DRY_RUN=false DAN BABLAST_API_KEY tersedia (Gate P4.13) --
// sebelum itu tetap dry-run/structured preview yang bisa diaudit di
// automation_outbox.payload (lihat /dispatch route).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";
import { SupabaseSalesmanDirectory } from "@/lib/n8n-automation/salesman-directory";
import {
  buildCollectionPlanForSalesman,
  buildCollectionPlanMorning,
  collectionPlanForSalesmanIdempotencyKey,
  collectionPlanMorningIdempotencyKey,
} from "@/lib/n8n-automation/collection-plan-morning";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { getCollectionPlanBySalesperson } from "@/lib/finance/queries";
import { normalizeIndonesianPhone } from "@/lib/integrations/bablast";

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

    const directory = new SupabaseSalesmanDirectory(admin);
    const owner = await directory.findActiveOwnerRecipient(credential.companyId);

    if (!owner) {
      return NextResponse.json({ error: "No active owner found for tenant" }, { status: 422 });
    }
    const ownerPhone = owner.phone ? normalizeIndonesianPhone(owner.phone) : null;
    if (!ownerPhone) {
      return NextResponse.json({ error: "Owner belum mengisi nomor telepon valid -- laporan tidak punya tujuan kirim" }, { status: 422 });
    }

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
      recipientUserId: owner.userId,
      recipientReference: ownerPhone,
      payload: { text: content.text, ...content.structured },
      idempotencyKey: collectionPlanMorningIdempotencyKey(credential.companyId, businessDate),
    });

    // Founder minta 2026-08-22: sales juga harus tahu toko mana yang perlu
    // DIA sendiri tagih, bukan cuma Owner yang dapat rekap semua sales.
    // Recipient WhatsApp per-sales (nomor telepon, bukan Telegram chat id) --
    // pola sama dengan Morning Brief (Gate P4.15). Selalu kirim walau 0 toko
    // (konsisten Morning Brief) supaya sales tahu laporannya jalan normal.
    const whatsappRecipients = await directory.listEligibleWhatsAppRecipients(credential.companyId);
    const salesmanResults: Record<string, unknown>[] = [];
    for (const recipient of whatsappRecipients) {
      const entries = planBySalesperson.get(recipient.userId) ?? [];
      const salesmanContent = buildCollectionPlanForSalesman({
        tenantName,
        salesmanFullName: recipient.fullName,
        businessDate,
        entries,
      });
      const salesmanEnqueue = await repository.enqueueJob({
        companyId: credential.companyId,
        credentialId: credential.id,
        requiredScope: REQUIRED_SCOPE,
        eventType: "COLLECTION_PLAN_MORNING",
        channel: "whatsapp",
        recipientUserId: recipient.userId,
        recipientReference: recipient.phone,
        payload: { text: salesmanContent.text, ...salesmanContent.structured },
        idempotencyKey: collectionPlanForSalesmanIdempotencyKey(recipient.userId, businessDate),
      });
      salesmanResults.push({ salesman: recipient.fullName, outcome: salesmanEnqueue.outcome });
    }

    return NextResponse.json({
      business_date: businessDate,
      salesmen_included: lines.length,
      outcome: enqueueResult.outcome,
      job_id: "jobId" in enqueueResult ? enqueueResult.jobId : null,
      salesman_results: salesmanResults,
    });
  } catch (err) {
    console.error("[Internal Automation /collection-plan-morning]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
