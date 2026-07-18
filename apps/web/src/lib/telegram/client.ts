// =============================================================================
// Telegram Bot API client — pengiriman balasan + verifikasi webhook secret.
//
// Autentikasi webhook Telegram TIDAK memakai HMAC seperti n8n — Telegram
// mengirim ulang string rahasia yang dipasang saat setWebhook(secret_token=...)
// via header X-Telegram-Bot-Api-Secret-Token. Ini bukan tanda tangan
// kriptografis, tapi tetap wajib dibandingkan secara timing-safe.
// =============================================================================

import { timingSafeEqual } from "crypto";

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
  /** Kirim pesan dengan inline keyboard -- fallback tetap berupa text (lihat parseNumberedChoice di menu router). */
  sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: InlineKeyboardButton[][],
  ): Promise<void>;
  /** Wajib dipanggil untuk setiap callback_query supaya loading spinner client Telegram berhenti. */
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
}

export function verifyTelegramSecret(headerValue: string | null): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return false; // secret belum dikonfigurasi -> tolak semua request
  if (!headerValue) return false;

  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export class HttpTelegramSender implements TelegramSender {
  constructor(private readonly botToken: string) {}

  async sendMessage(chatId: number, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Telegram] sendMessage failed (${res.status}): ${body}`);
    }
  }

  async sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: InlineKeyboardButton[][],
  ): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: keyboard.map((row) =>
            row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
          ),
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Telegram] sendMessageWithKeyboard failed (${res.status}): ${body}`);
    }
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Telegram] answerCallbackQuery failed (${res.status}): ${body}`);
    }
  }
}

/** Dipakai di test — tidak melakukan HTTP call, hanya mencatat pesan yang "terkirim". */
export class RecordingTelegramSender implements TelegramSender {
  public readonly sent: { chatId: number; text: string }[] = [];
  public readonly sentWithKeyboard: {
    chatId: number;
    text: string;
    keyboard: InlineKeyboardButton[][];
  }[] = [];
  public readonly answeredCallbackQueries: string[] = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }

  async sendMessageWithKeyboard(
    chatId: number,
    text: string,
    keyboard: InlineKeyboardButton[][],
  ): Promise<void> {
    this.sentWithKeyboard.push({ chatId, text, keyboard });
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    this.answeredCallbackQueries.push(callbackQueryId);
  }
}

// ---------------------------------------------------------------------------
// Minimal Telegram Update payload types yang kita pakai — tidak percaya
// field lain di luar ini.
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    voice?: { file_id: string; duration: number };
    /** Telegram mengirim beberapa resolusi per foto — dipakai entry terakhir (terbesar). */
    photo?: { file_id: string; width: number; height: number }[];
    document?: { file_id: string; file_name?: string };
    location?: { latitude: number; longitude: number };
    chat: {
      id: number;
      type?: "private" | "group" | "supergroup" | "channel";
    };
    from?: { id: number; username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number; type?: "private" | "group" | "supergroup" | "channel" };
    };
    from?: { id: number; username?: string };
  };
}
