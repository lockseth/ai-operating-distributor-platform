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
import { SupabaseOrderDisputeRepository } from "@/lib/order-disputes/repository";
import {
  SupabaseDisputeConversationRepository,
  detectDisputeTrigger,
} from "@/lib/order-disputes/conversation";
import { processDisputeMessage } from "@/lib/order-disputes/workflow";
import { SupabaseDispatchRepository } from "@/lib/dispatch/repository";
import { SupabaseCustomerPicRepository } from "@/lib/customer-pic/repository";
import {
  SupabaseStorePicConversationRepository,
  detectAddStoreTrigger,
  detectAddPicTrigger,
} from "@/lib/customer-pic/conversation";
import { processAddStoreMessage } from "@/lib/customer-pic/workflow";

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
    const salesOrderRepository = new SupabaseSalesOrderRepository(supabase);
    const deliveryRepository = new SupabaseDeliveryRepository(supabase);
    const sender = new HttpTelegramSender(botToken);

    // --- Alur "Batalkan/Sengketakan Order" dan "Tambah Toko" didahulukan
    // mirip pola Delivery Verification (driver) di processTelegramUpdate:
    // satu ledger idempotency (telegram_update_events) melayani SEMUA alur,
    // jadi cek dedup + insert event di sini juga -- lib/sales-orders/
    // workflow.ts (locked, tidak diubah) tidak tahu soal dispute/tambah
    // toko, jadi pre-check ini WAJIB di route, bukan di dalamnya. Prioritas:
    // (1) percakapan yang SUDAH aktif untuk identity ini selalu dilanjutkan
    // dulu (tidak pernah dibajak alur lain), (2) baru trigger kata kunci
    // dicek HANYA kalau tidak ada percakapan lain (termasuk sales-order/
    // delivery) yang sedang aktif.
    const text = update.message?.text;
    if (text) {
      const alreadyProcessed = await salesOrderRepository.findEventByUpdateId(update.update_id);
      if (!alreadyProcessed) {
        const chatId = update.message!.chat.id;
        const identity = await salesOrderRepository.resolveIdentity(chatId);
        if (identity) {
          const disputeConversationRepository = new SupabaseDisputeConversationRepository(supabase);
          const storePicConversationRepository = new SupabaseStorePicConversationRepository(supabase);
          const disputeState = await disputeConversationRepository.getState(identity.identityId);
          const storePicState = await storePicConversationRepository.getState(identity.identityId);
          const disputeActive = disputeState.awaiting !== "none";
          const storePicActive = storePicState.awaiting !== "none";

          let shouldHandleDispute = disputeActive;
          let shouldHandleStorePic = !disputeActive && storePicActive;

          if (!shouldHandleDispute && !shouldHandleStorePic) {
            const salesOrderConvo = await salesOrderRepository.getConversationState(identity.identityId);
            const deliveryConvo = await deliveryRepository.getConversationState(identity.identityId);
            const otherFlowActive = salesOrderConvo.awaiting !== "none" || deliveryConvo.awaiting !== "none";
            if (!otherFlowActive) {
              const trigger = detectDisputeTrigger(text);
              shouldHandleDispute = trigger.isTrigger && trigger.orderNumber !== null;
              if (!shouldHandleDispute) shouldHandleStorePic = detectAddStoreTrigger(text) || detectAddPicTrigger(text);
            }
          }

          if (shouldHandleDispute) {
            const event = await salesOrderRepository.insertEvent({
              telegramUpdateId: update.update_id,
              companyId: identity.companyId,
              telegramIdentityId: identity.identityId,
              messageType: "text",
              processingStatus: "received",
              rawPayload: update,
            });
            const disputeResult = await processDisputeMessage(text, chatId, identity, {
              repository: new SupabaseOrderDisputeRepository(supabase),
              conversationRepository: disputeConversationRepository,
              sender,
              dispatchRepository: new SupabaseDispatchRepository(supabase),
              deliveryRepository,
            });
            await salesOrderRepository.updateEventStatus(event.id, "processed");
            return NextResponse.json({ ok: true, outcome: "order_dispute", result: disputeResult.outcome });
          }

          if (shouldHandleStorePic) {
            const event = await salesOrderRepository.insertEvent({
              telegramUpdateId: update.update_id,
              companyId: identity.companyId,
              telegramIdentityId: identity.identityId,
              messageType: "text",
              processingStatus: "received",
              rawPayload: update,
            });
            const storePicResult = await processAddStoreMessage(text, chatId, identity, {
              repository: new SupabaseCustomerPicRepository(supabase),
              conversationRepository: storePicConversationRepository,
              sender,
            });
            await salesOrderRepository.updateEventStatus(event.id, "processed");
            return NextResponse.json({ ok: true, outcome: "add_store", result: storePicResult.outcome });
          }
        }
      }
    }

    const deps: WorkflowDeps = {
      repository: salesOrderRepository,
      knowledgeProvider: new SupabaseKnowledgeProvider(supabase),
      sender,
      deliveryRepository,
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
