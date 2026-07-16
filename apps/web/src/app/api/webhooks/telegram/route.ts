// =============================================================================
// Inbound Webhook — Telegram Sales Order Entry
//
// Route ini SENGAJA tipis: verifikasi + parsing saja, seluruh logika bisnis
// didelegasikan ke processTelegramUpdate() (apps/web/src/lib/sales-orders).
// Tidak ada panggilan vendor AI dari sini.
//
// Autentikasi: header X-Telegram-Bot-Api-Secret-Token dibandingkan
// timing-safe terhadap TELEGRAM_WEBHOOK_SECRET (lihat lib/telegram/client.ts).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import {
  checkRateLimit,
  getClientIp,
  buildRateLimitResponse,
} from "@/lib/rate-limit";
import {
  verifyTelegramSecret,
  HttpTelegramSender,
  type TelegramUpdate,
} from "@/lib/telegram/client";
import { SupabaseSalesOrderRepository } from "@/lib/sales-orders/repository";
import { SupabaseKnowledgeProvider } from "@/lib/sales-orders/knowledge-provider";
import {
  processTelegramUpdate,
  type WorkflowDeps,
} from "@/lib/sales-orders/workflow";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";
import { SupabaseTelegramEnrollmentRepository } from "@/lib/telegram-enrollment/repository";

// 60 update/menit per IP — cukup longgar untuk trafik bot wajar, mencegah flood.
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`telegram:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!verifyTelegramSecret(secretHeader)) {
      return NextResponse.json(
        { error: "Unauthorized: invalid or missing secret" },
        { status: 401 },
      );
    }

    const rawBody = await request.text();
    let update: TelegramUpdate;
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (typeof update.update_id !== "number") {
      return NextResponse.json({ error: "Missing update_id" }, { status: 400 });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.error(
        "[Webhook /telegram] TELEGRAM_BOT_TOKEN belum dikonfigurasi",
      );
      return NextResponse.json(
        { error: "Server misconfigured" },
        { status: 500 },
      );
    }

    const supabase = getAdminClient();
    const deps: WorkflowDeps = {
      repository: new SupabaseSalesOrderRepository(supabase),
      knowledgeProvider: new SupabaseKnowledgeProvider(supabase),
      sender: new HttpTelegramSender(botToken),
      deliveryRepository: new SupabaseDeliveryRepository(supabase),
      enrollmentRepository: new SupabaseTelegramEnrollmentRepository(supabase),
    };

    const result = await processTelegramUpdate(update, deps);
    const outcome =
      result.outcome === "delivery" ? result.result.outcome : result.outcome;

    return NextResponse.json({ ok: true, outcome });
  } catch (err) {
    console.error("[Webhook /telegram]", err);
    // Tetap balas 200 setelah update tervalidasi supaya Telegram tidak retry
    // storm akibat error internal — error sudah dicatat di server log.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
