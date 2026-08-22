// =============================================================================
// Internal Automation API -- generate Morning Brief. Membuat SATU outbox job
// PENDING per salesman aktif+nomor telepon valid, idempotent per
// (salesperson, business date Asia/Jakarta). Konten SELALU dari
// lib/sales-kpi/* (achievement projection + calibration baseline) --
// endpoint ini TIDAK menghitung Call/EC/achievement sendiri, hanya
// memanggil service AODP lalu merangkai teks lewat presenter
// (lib/n8n-automation/morning-brief.ts).
//
// Gate P4.15 (2026-08-22): channel dipindah dari Telegram ke WhatsApp --
// alasan Founder: (1) awalnya Telegram dipilih karena provider WA lama
// (Fonnte) mahal, sekarang sudah pakai Bablast yang lebih murah dan sudah
// terhubung; (2) sales lebih familiar WhatsApp; (3) WhatsApp AODP TIDAK
// dipakai sebagai chatbot customer, jadi tidak ada risiko campur channel.
// Telegram Sales Order Entry (input order) TIDAK berubah -- itu sistem
// terpisah, tidak disentuh sama sekali.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential } from "@/lib/n8n-automation/service";
import { SupabaseSalesmanDirectory } from "@/lib/n8n-automation/salesman-directory";
import { composeMorningBriefForSalesman, morningBriefIdempotencyKey } from "@/lib/n8n-automation/morning-brief";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { SupabaseSalesKpiRepository } from "@/lib/sales-kpi/repository";
import { SupabaseCustomerDataGapRepository } from "@/lib/customers/data-completeness";

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
    const customerDataGapRepository = new SupabaseCustomerDataGapRepository(admin);

    const directory = new SupabaseSalesmanDirectory(admin);
    const recipients = await directory.listEligibleWhatsAppRecipients(credential.companyId);

    let created = 0;
    let skipped = 0;
    const results: Record<string, unknown>[] = [];

    for (const recipient of recipients) {
      const content = await composeMorningBriefForSalesman(
        { salesKpiRepository, customerDataGapRepository },
        credential.companyId,
        credential.id,
        { userId: recipient.userId, fullName: recipient.fullName, coverageAreas: recipient.coverageAreas },
        tenantName,
        businessDate,
      );

      const enqueueResult = await repository.enqueueJob({
        companyId: credential.companyId,
        credentialId: credential.id,
        requiredScope: REQUIRED_SCOPE,
        eventType: "MORNING_BRIEF",
        channel: "whatsapp",
        recipientUserId: recipient.userId,
        recipientReference: recipient.phone,
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
