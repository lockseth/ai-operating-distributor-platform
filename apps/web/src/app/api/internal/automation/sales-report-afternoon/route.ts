// =============================================================================
// Internal Automation API -- generate Laporan Sales Sore untuk Owner. Fase B
// redesain Laporan Sales (Gate P4.03 Fase A), Gate P4.11: hasil kerja HARI
// ITU per sales (EC-to-transaksi, Omzet, Tagihan), dijadwalkan n8n ~16:30 WIB
// hari kerja. Channel 'whatsapp', dikirim nyata lewat Bablast begitu
// BABLAST_DRY_RUN=false DAN BABLAST_API_KEY tersedia (Gate P4.13) --
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
  buildSalesReportAfternoon,
  salesReportAfternoonIdempotencyKey,
} from "@/lib/n8n-automation/sales-report-afternoon";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";
import { SupabaseSalesKpiRepository } from "@/lib/sales-kpi/repository";
import { getOutstandingSummaryBySalesperson } from "@/lib/finance/queries";
import { normalizeIndonesianPhone } from "@/lib/integrations/bablast";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const REQUIRED_SCOPE = "automation.sales_report_afternoon.generate";

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-sales-report-afternoon:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
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

    const salesKpiRepository = new SupabaseSalesKpiRepository(admin);
    const activePeriod = await salesKpiRepository.findActivePeriod(credential.companyId);

    const recipients = await directory.listEligibleMorningBriefRecipients(credential.companyId);

    const tagihanBySalesperson = await getOutstandingSummaryBySalesperson(credential.companyId, businessDate, admin);
    const emptyTagihan = { outstandingCount: 0, outstandingTotal: 0, overdueCount: 0 };

    const lines = [];
    if (activePeriod) {
      for (const recipient of recipients) {
        const projectionResult = await salesKpiRepository.getAchievementProjection({
          companyId: credential.companyId,
          actorId: credential.id,
          periodId: activePeriod.id,
          salespersonId: recipient.userId,
        });
        lines.push({
          salesmanFullName: recipient.fullName,
          projection: projectionResult.outcome === "ok" ? projectionResult.projection : null,
          tagihan: tagihanBySalesperson.get(recipient.userId) ?? emptyTagihan,
        });
      }
    }

    const content = buildSalesReportAfternoon({ tenantName, businessDate, activePeriod, lines });

    const enqueueResult = await repository.enqueueJob({
      companyId: credential.companyId,
      credentialId: credential.id,
      requiredScope: REQUIRED_SCOPE,
      eventType: "SALES_REPORT_AFTERNOON",
      channel: "whatsapp",
      recipientUserId: owner.userId,
      recipientReference: ownerPhone,
      payload: { text: content.text, ...content.structured },
      idempotencyKey: salesReportAfternoonIdempotencyKey(credential.companyId, businessDate),
    });

    return NextResponse.json({
      business_date: businessDate,
      salesmen_included: lines.length,
      outcome: enqueueResult.outcome,
      job_id: "jobId" in enqueueResult ? enqueueResult.jobId : null,
    });
  } catch (err) {
    console.error("[Internal Automation /sales-report-afternoon]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
