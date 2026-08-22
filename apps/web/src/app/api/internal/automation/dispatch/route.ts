// =============================================================================
// Internal Automation API -- dispatch: claim + kirim + complete/fail dalam
// SATU panggilan atomik per job (menghindari split-brain n8n-mengirim-lalu-
// lupa-lapor-balik). Memakai ULANG TelegramSender interface (lib/telegram/
// client.ts) -- TIDAK menduplikasi logic pengiriman Telegram existing.
//
// AUTOMATION_DRY_RUN default TRUE (aman) -- hanya "false" eksplisit yang
// mengizinkan HttpTelegramSender (kirim nyata).
//
// WhatsApp (Gate P4.13) memakai saklar TERPISAH, BABLAST_DRY_RUN, default
// TRUE juga -- hanya "false" eksplisit DAN BABLAST_API_KEY tersedia yang
// mengizinkan pengiriman nyata lewat Bablast. Sengaja dipisah dari
// AUTOMATION_DRY_RUN (provider beda, kesiapan beda) supaya mengaktifkan satu
// channel tidak diam-diam mengaktifkan channel lain.
//
// TEST OVERRIDE (insiden 2026-08-22): trigger manual/tes SEBELUMNYA bisa
// mengirim WA nyata ke nomor client asli (recipient_reference selalu dari
// data produksi, tidak pernah dibedakan "ini tes" vs "ini beneran") --
// terjadi ke nomor Owner tenant tanpa pemberitahuan dulu, berisiko dikira
// spam/disadap oleh client. Sekarang kalau BABLAST_TEST_OVERRIDE_PHONE /
// TELEGRAM_TEST_OVERRIDE_CHAT_ID diset, SEMUA pengiriman channel itu --
// termasuk saat BABLAST_DRY_RUN=false -- dialihkan ke nomor/chat id itu,
// bukan recipient_reference asli. Ini pagar keras: bukan sekadar "ingat-
// ingat manual", benar-benar tidak ada jalur kode yang bisa tembus ke
// client asli selama override ini aktif.
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";
import { SupabaseAutomationRepository } from "@/lib/n8n-automation/repository";
import { resolveAutomationCredential, sanitizeAutomationError } from "@/lib/n8n-automation/service";
import { HttpTelegramSender, RecordingTelegramSender, type TelegramSender } from "@/lib/telegram/client";
import { isBablastLiveSendEnabled, sendBablastMessage } from "@/lib/integrations/bablast";
import { resolveTelegramTarget, resolveWhatsAppTarget } from "@/lib/n8n-automation/dispatch-target";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function resolveTelegramSender(): TelegramSender {
  const dryRun = process.env.AUTOMATION_DRY_RUN !== "false";
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!dryRun && botToken) return new HttpTelegramSender(botToken);
  return new RecordingTelegramSender();
}

interface WhatsAppSender {
  sendMessage(phone: string, text: string): Promise<string | null>;
}

class BablastWhatsAppSender implements WhatsAppSender {
  async sendMessage(phone: string, text: string): Promise<string | null> {
    const result = await sendBablastMessage(phone, text);
    return result.providerMessageId;
  }
}

class RecordingWhatsAppSender implements WhatsAppSender {
  async sendMessage(): Promise<string | null> {
    return "dry-run";
  }
}

function resolveWhatsAppSender(): WhatsAppSender {
  return isBablastLiveSendEnabled() ? new BablastWhatsAppSender() : new RecordingWhatsAppSender();
}

const PHONE_LIKE_PATTERN = /^\+?[0-9]{8,15}$/;

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
    const whatsappSender = resolveWhatsAppSender();
    const results: Record<string, unknown>[] = [];

    for (const job of claimResult.jobs) {
      const text = typeof job.payload.text === "string" ? job.payload.text : JSON.stringify(job.payload);

      try {
        let providerMessageId: string | null;
        if (job.channel === "telegram") {
          const chatId = resolveTelegramTarget(job.recipientReference);
          if (!Number.isFinite(chatId)) throw new Error("invalid recipient_reference for telegram channel");
          await telegramSender.sendMessage(chatId, text);
          providerMessageId = telegramSender instanceof RecordingTelegramSender ? "dry-run" : null;
        } else {
          // whatsapp: recipient_reference wajib nomor telepon tujuan sejak Gate P4.13
          // (sebelumnya "owner:<id>", sekarang nomor asli -- lihat route generator).
          const targetPhone = resolveWhatsAppTarget(job.recipientReference);
          if (!PHONE_LIKE_PATTERN.test(targetPhone)) {
            throw new Error("invalid recipient_reference for whatsapp channel (bukan format nomor telepon)");
          }
          providerMessageId = await whatsappSender.sendMessage(targetPhone, text);
        }

        const completeResult = await repository.completeJob({
          companyId: credential.companyId,
          credentialId: credential.id,
          jobId: job.jobId,
          providerMessageId,
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
      dry_run: {
        telegram: telegramSender instanceof RecordingTelegramSender,
        whatsapp: whatsappSender instanceof RecordingWhatsAppSender,
      },
      test_override_active: {
        telegram: Boolean(process.env.TELEGRAM_TEST_OVERRIDE_CHAT_ID),
        whatsapp: Boolean(process.env.BABLAST_TEST_OVERRIDE_PHONE),
      },
      claimed: claimResult.jobs.length,
      results,
    });
  } catch (err) {
    console.error("[Internal Automation /dispatch]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
