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

export interface GenerateAndDispatchResult {
  generate: Record<string, unknown>;
  dispatch: Record<string, unknown>;
}

/**
 * Panggil endpoint generate (POST, credential Bearer) lalu langsung
 * /dispatch (claim+kirim) dalam satu invocation cron -- dibutuhkan karena
 * Vercel Cron di plan Hobby dibatasi 1x/hari per cron, tidak bisa poll
 * dispatcher terpisah tiap menit seperti pola n8n lama.
 */
export async function generateAndDispatch(
  request: Request,
  generatePath: string,
): Promise<GenerateAndDispatchResult> {
  const internalToken = process.env.INTERNAL_AUTOMATION_TOKEN;
  if (!internalToken) throw new Error("INTERNAL_AUTOMATION_TOKEN belum diset di environment");

  const origin = new URL(request.url).origin;
  const headers = { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" };

  const generateRes = await fetch(`${origin}${generatePath}`, { method: "POST", headers, body: "{}" });
  const generate = await generateRes.json().catch(() => ({}));

  const dispatchRes = await fetch(`${origin}/api/internal/automation/dispatch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ max_jobs: 5 }),
  });
  const dispatch = await dispatchRes.json().catch(() => ({}));

  return { generate, dispatch };
}
