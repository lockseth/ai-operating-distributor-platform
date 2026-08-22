// =============================================================================
// Vercel Cron orchestration -- Gate P4.14. Menggantikan peran n8n sebagai
// PENJADWAL (cron trigger) untuk 4 laporan terjadwal (Morning Brief, KPI
// Daily Summary, Laporan Sore, Rencana Penagihan Pagi). n8n sebelumnya TIDAK
// PERNAH mengirim pesan sendiri -- pengiriman selalu di kode AODP
// (lib/telegram/client.ts, lib/integrations/bablast.ts) via /dispatch, n8n
// cuma memanggil endpoint generate lalu /dispatch terjadwal. Modul ini
// menggantikan bagian "memanggil terjadwal" itu saja.
//
// Autentikasi caller (Vercel Cron) memakai CRON_SECRET (pola resmi Vercel --
// Vercel mengirim ulang `Authorization: Bearer <CRON_SECRET>` ke endpoint
// cron). Autentikasi ke endpoint generate/dispatch internal TETAP memakai
// n8n_inbound_credentials yang sudah ada (Bearer token terpisah,
// INTERNAL_AUTOMATION_TOKEN) -- tidak ada jalur baru yang melewati scope
// check yang sudah ada, cron cuma pemanggil baru dengan token yang sama
// polanya seperti n8n.
// =============================================================================

export function verifyCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export interface GenerateAndDispatchStepResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface GenerateAndDispatchResult {
  ok: boolean;
  generate: GenerateAndDispatchStepResult;
  dispatch: GenerateAndDispatchStepResult;
}

async function callInternalRoute(
  origin: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<GenerateAndDispatchStepResult> {
  const res = await fetch(`${origin}${path}`, { method: "POST", headers, body });
  const rawText = await res.text().catch(() => "");
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};
  } catch {
    // Response bukan JSON (mis. halaman auth-challenge Vercel) -- simpan
    // cuplikan mentahnya supaya kegagalan tetap terlihat, bukan diam-diam
    // jadi objek kosong.
    parsedBody = { raw: rawText.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, body: parsedBody };
}

/**
 * Panggil endpoint generate (POST, credential Bearer) lalu langsung
 * /dispatch (claim+kirim) dalam satu invocation cron -- dibutuhkan karena
 * Vercel Cron di plan Hobby dibatasi 1x/hari per cron, tidak bisa poll
 * dispatcher terpisah tiap menit seperti pola n8n lama.
 *
 * PENTING: status HTTP tiap panggilan internal WAJIB diperiksa eksplisit
 * (res.ok) -- fetch() TIDAK melempar error untuk response 4xx/5xx, cuma
 * untuk kegagalan jaringan. Tanpa pemeriksaan ini, generate/dispatch yang
 * gagal (401/422/500) akan diam-diam dianggap sukses oleh route cron
 * pemanggil (ditemukan saat verifikasi hosted pertama, Gate P4.14).
 */
export async function generateAndDispatch(
  request: Request,
  generatePath: string,
): Promise<GenerateAndDispatchResult> {
  const internalToken = process.env.INTERNAL_AUTOMATION_TOKEN;
  if (!internalToken) throw new Error("INTERNAL_AUTOMATION_TOKEN belum diset di environment");

  // SENGAJA bukan new URL(request.url).origin -- Vercel Cron memanggil cron
  // route ini lewat URL deployment spesifik (bukan domain production alias),
  // dan URL deployment itu bisa terkena proteksi Vercel Authentication yang
  // memblokir fetch-diri-sendiri ke rute internal di origin yang sama
  // (ditemukan saat verifikasi hosted Gate P4.14 -- generate/dispatch selalu
  // gagal diam-diam padahal token & credential benar). NEXT_PUBLIC_APP_URL
  // (domain production stabil) tidak kena proteksi itu.
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const headers = { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" };

  const generate = await callInternalRoute(origin, generatePath, headers, "{}");
  const dispatch = await callInternalRoute(
    origin,
    "/api/internal/automation/dispatch",
    headers,
    JSON.stringify({ max_jobs: 5 }),
  );

  return { ok: generate.ok && dispatch.ok, generate, dispatch };
}
