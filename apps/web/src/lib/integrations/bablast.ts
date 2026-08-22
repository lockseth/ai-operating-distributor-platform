// =============================================================================
// Bablast WhatsApp API client — Gate P4.13. "Unofficial Sender" (pairing
// code/QR, mirip WhatsApp Web -- BUKAN WhatsApp Business API resmi Meta),
// kontrak dikonfirmasi langsung dari dashboard Bablast (2026-08-20, lihat
// TRACKER.md). BABLAST_API_KEY dibaca dari env server-side, TIDAK PERNAH
// diekspos ke client atau ditulis ke log/response.
// =============================================================================

const BABLAST_BASE_URL = "https://api.bablast.id";

/**
 * Normalisasi nomor Indonesia ke format `62xxxxxxxxxx` (tanpa "+", tanpa "0"
 * depan) -- konvensi umum WhatsApp API provider. Input boleh mengandung
 * spasi/dash/tanda kurung (mis. hasil ketik bebas di form signup). Return
 * null kalau setelah dibersihkan tidak terlihat seperti nomor telepon valid
 * (bukan validasi ketat, cuma penjaga sebelum dikirim ke provider).
 */
export function normalizeIndonesianPhone(raw: string): string | null {
  let digits = raw.replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (!digits.startsWith("62")) digits = `62${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function getApiKey(): string {
  const key = process.env.BABLAST_API_KEY;
  if (!key) throw new Error("BABLAST_API_KEY belum diset di environment");
  return key;
}

async function bablastFetch(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${BABLAST_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${getApiKey()}`,
    },
  });

  const rawText = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    body = { raw: rawText };
  }

  if (!res.ok) {
    throw new Error(`Bablast ${path} gagal (${res.status}): ${rawText.slice(0, 300)}`);
  }
  return body;
}

export interface BablastSendResult {
  providerMessageId: string | null;
  raw: Record<string, unknown>;
}

/** Kirim pesan teks WhatsApp lewat Bablast. Melempar error kalau gagal -- pemanggil (dispatch route) menangani retry/dead-letter. */
export async function sendBablastMessage(phone: string, message: string): Promise<BablastSendResult> {
  const body = await bablastFetch("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, message }),
  });
  const providerMessageId =
    (typeof body.id === "string" && body.id) ||
    (typeof body.message_id === "string" && body.message_id) ||
    (typeof body.messageId === "string" && body.messageId) ||
    null;
  return { providerMessageId, raw: body };
}

export interface BablastConnectorStatus {
  connected: boolean;
  raw: Record<string, unknown>;
}

/** Cek apakah nomor WhatsApp sender sudah ter-pairing/connected. */
export async function getBablastConnectorStatus(): Promise<BablastConnectorStatus> {
  const body = await bablastFetch("/connector/status", { method: "GET" });
  const statusValue = typeof body.status === "string" ? body.status.toLowerCase() : null;
  const connected =
    body.connected === true ||
    statusValue === "connected" ||
    statusValue === "online" ||
    statusValue === "paired";
  return { connected, raw: body };
}

export interface BablastPairingResult {
  /** Kode pairing teks (kalau provider mengembalikan format ini). */
  pairingCode: string | null;
  /** URL/data QR code (kalau provider mengembalikan format ini). */
  qrCode: string | null;
  raw: Record<string, unknown>;
}

/** Mulai proses pairing nomor WhatsApp -- hasilnya kode/QR yang wajib di-scan pemilik nomor di HP-nya sendiri, AODP tidak bisa melakukan langkah scan itu. */
export async function initiateBablastPairing(): Promise<BablastPairingResult> {
  const body = await bablastFetch("/connector/pairing", { method: "POST" });
  const pairingCode =
    (typeof body.pairing_code === "string" && body.pairing_code) ||
    (typeof body.code === "string" && body.code) ||
    null;
  const qrCode =
    (typeof body.qr_code === "string" && body.qr_code) ||
    (typeof body.qr === "string" && body.qr) ||
    (typeof body.qrCode === "string" && body.qrCode) ||
    null;
  return { pairingCode, qrCode, raw: body };
}
