// =============================================================================
// Telegram Bot API client — pengiriman balasan + verifikasi webhook secret.
//
// Autentikasi webhook Telegram TIDAK memakai HMAC seperti n8n — Telegram
// mengirim ulang string rahasia yang dipasang saat setWebhook(secret_token=...)
// via header X-Telegram-Bot-Api-Secret-Token. Ini bukan tanda tangan
// kriptografis, tapi tetap wajib dibandingkan secara timing-safe.
// =============================================================================

import { timingSafeEqual } from "crypto";

export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
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
}

/** Dipakai di test — tidak melakukan HTTP call, hanya mencatat pesan yang "terkirim". */
export class RecordingTelegramSender implements TelegramSender {
  public readonly sent: { chatId: number; text: string }[] = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
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
    chat: { id: number };
    from?: { id: number; username?: string };
  };
}
