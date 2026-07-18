// =============================================================================
// Internal Automation API -- dispatch: claim + kirim + complete/fail dalam
// SATU panggilan atomik per job (menghindari split-brain n8n-mengirim-lalu-
// lupa-lapor-balik). Memakai ULANG TelegramSender interface (lib/telegram/
// client.ts) -- TIDAK menduplikasi logic pengiriman Telegram existing.
//
// AUTOMATION_DRY_RUN default TRUE (aman) -- hanya "false" eksplisit yang
// mengizinkan HttpTelegramSender (kirim nyata). WhatsApp (KPI_DAILY_SUMMARY)
// SELALU dry-run terlepas dari env ini -- WhatsApp production sengaja tidak
// diimplementasikan phase ini (structured preview/delivery-attempt saja).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential, sanitizeAutomationError } from "@/lib/n8n-automation/service";
import { HttpTelegramSender, RecordingTelegramSender, type TelegramSender } from "@/lib/telegram/client";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function resolveTelegramSender(): TelegramSender {
  const dryRun = process.env.AUTOMATION_DRY_RUN !== "false";
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!dryRun && botToken) return new HttpTelegramSender(botToken);
  return new RecordingTelegramSender();
}

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`automation-dispatch:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const repository = new SupabaseAutomationRepository(getAdminClient());
    const credential = await resolveAutomationCredential(
      request.headers.get("Authorization"),
      repository,
    );
    if (!credential) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { max_jobs?: unknown };
    const maxJobs = typeof body.max_jobs === "number" ? body.max_jobs : 5;

    const claimResult = await repository.claimJobs({
      companyId: credential.companyId,
      credentialId: credential.id,
      maxJobs,
      workerLabel: `dispatch-${ip}`,
    });
    if (claimResult.outcome === "forbidden") {
      return NextResponse.json({ error: "Forbidden: credential missing automation.claim scope" }, { status: 403 });
    }
    if (claimResult.outcome === "invalid_max_jobs") {
      return NextResponse.json({ error: "max_jobs must be an integer between 1 and 50" }, { status: 400 });
    }
    if (claimResult.outcome !== "claimed") {
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    const telegramSender = resolveTelegramSender();
    const results: Record<string, unknown>[] = [];

    for (const job of claimResult.jobs) {
      const text = typeof job.payload.text === "string" ? job.payload.text : JSON.stringify(job.payload);

      try {
        if (job.channel === "telegram") {
          const chatId = Number(job.recipientReference);
          if (!Number.isFinite(chatId)) throw new Error("invalid recipient_reference for telegram channel");
          await telegramSender.sendMessage(chatId, text);
        } else {
          // whatsapp: SELALU dry-run, tidak ada pengiriman nyata (lihat header file).
          void text;
        }

        const completeResult = await repository.completeJob({
          companyId: credential.companyId,
          credentialId: credential.id,
          jobId: job.jobId,
          providerMessageId: telegramSender instanceof RecordingTelegramSender ? "dry-run" : null,
        });
        results.push({ job_id: job.jobId, outcome: completeResult.outcome });
      } catch (sendErr) {
        const message = sendErr instanceof Error ? sendErr.message : "send failed";
        const failResult = await repository.failJob({
          companyId: credential.companyId,
          credentialId: credential.id,
          jobId: job.jobId,
          error: sanitizeAutomationError(message),
          retryable: true,
        });
        results.push({ job_id: job.jobId, outcome: failResult.outcome, status: "status" in failResult ? failResult.status : undefined });
      }
    }

    return NextResponse.json({
      dry_run: telegramSender instanceof RecordingTelegramSender,
      claimed: claimResult.jobs.length,
      results,
    });
  } catch (err) {
    console.error("[Internal Automation /dispatch]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
